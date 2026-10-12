#!/usr/bin/env node
// Attribute Claude Code spend to git branches and send the per-day, per-branch totals to a CodeSpend server.
// Run it inside a repository (or pass --repo). It sends dates, branch names, token counts, costs and commit
// counts only: never prompts, file contents, paths, names or emails.
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { collect } from '../src/attribution.js';

const USAGE = `Usage: codespend-branches [options]

Reads Claude Code's session logs for this repository, charges each model call to the git branch that was
checked out at that moment (from the repository's reflog), and posts the totals to CodeSpend.

Options:
  --repo <dir>       repository to read (default: the current folder)
  --project <label>  CodeSpend project (default: owner/repo from the origin remote, else the folder name)
  --server <url>     CodeSpend server (default: $CODESPEND_URL or http://127.0.0.1:3000)
  --since <date>     first UTC day to include, YYYY-MM-DD (default: the 1st of last month)
  --dry-run          print the breakdown, send nothing
  -h, --help         show this help

Claude Code logs are read from $CLAUDE_CONFIG_DIR, else ~/.config/claude and ~/.claude.`;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMEOUT_MS = 30_000;

function fail(message, usage = false) {
  console.error(`codespend-branches: ${message}`);
  if (usage) console.error(`\n${USAGE}`);
  process.exit(1);
}

function firstOfLastMonth(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 10);
}

let opts;
try {
  opts = parseArgs({
    options: {
      repo: { type: 'string' },
      project: { type: 'string' },
      server: { type: 'string' },
      since: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  }).values;
} catch (e) {
  fail(e.message, true);
}
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
const since = opts.since ?? firstOfLastMonth();
if (!DATE.test(since) || Number.isNaN(Date.parse(`${since}T00:00:00Z`))) fail('--since must be a date like 2026-10-01', true);
const server = (opts.server ?? process.env.CODESPEND_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const claudeDirs = process.env.CLAUDE_CONFIG_DIR ? [process.env.CLAUDE_CONFIG_DIR] : [join(homedir(), '.config', 'claude'), join(homedir(), '.claude')];

let r;
try {
  r = await collect({ repo: opts.repo ?? process.cwd(), claudeDirs, since });
} catch (e) {
  fail(e.message);
}
const project = opts.project ?? r.project;

const usd = (n) => `$${n.toFixed(2)}`;
const byBranch = new Map();
for (const row of r.rows) {
  const b = byBranch.get(row.branch) ?? { costUsd: 0, tokens: 0, commits: 0 };
  byBranch.set(row.branch, { costUsd: b.costUsd + row.costUsd, tokens: b.tokens + row.tokens, commits: b.commits + row.commits });
}
const total = [...byBranch.values()].reduce((a, b) => a + b.costUsd, 0);
console.log(`CodeSpend branches for ${project} since ${since}: ${r.calls} Claude Code call(s) in ${r.files} log file(s), ${usd(total)} in total`);
const width = Math.max(6, ...[...byBranch.keys()].map((b) => b.length));
for (const [branch, b] of [...byBranch].sort((x, y) => y[1].costUsd - x[1].costUsd)) {
  console.log(`  ${branch.padEnd(width)}  ${usd(b.costUsd).padStart(9)}  ${b.tokens.toLocaleString('en-US')} tokens  ${b.commits} commit${b.commits === 1 ? '' : 's'}`);
}
for (const w of r.warnings) console.error(`warning: ${w}`);

if (opts['dry-run']) {
  console.log('Dry run: nothing was sent.');
  process.exit(0);
}

let res;
try {
  res = await fetch(`${server}/api/branches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project, source: r.source, rows: r.rows }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
} catch (e) {
  fail(`could not reach ${server} (${e.cause?.code ?? e.message}). Is CodeSpend running? Start it with npm start, or pass --server.`);
}
const body = await res.json().catch(() => ({}));
if (!res.ok) fail(`${server} refused the report: ${res.status} ${body.error ?? ''}`.trim());
console.log(`Sent ${body.rows ?? r.rows.length} row(s) to ${server} as project "${body.project ?? project}".`);
