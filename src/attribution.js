// Branch attribution, computed on the developer's machine (billing APIs report by key and day, never by branch).
//
//   Claude Code transcripts (~/.claude/projects/*/*.jsonl): every model call with its time, cwd, model and tokens
//   the repo's HEAD reflog (git rev-parse --git-path logs/HEAD): which branch was checked out when, and its commits
//     └─> each call is charged to the branch checked out at its timestamp, priced, and grouped by (UTC day, branch)
//
// Transcript fields and model prices follow Claude Code's and Anthropic's public docs; they are unverified (see BUILD.md).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, basename, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';

export const UNKNOWN = '(unknown)';
export const DETACHED = '(detached)';
const MICRO = 1e6;

const execFileP = promisify(execFile);
const utcDate = (t) => new Date(t).toISOString().slice(0, 10);
const round6 = (n) => Math.round(n * MICRO) / MICRO;

// ---------- git reflog -> branch timeline ----------

// "<old> <new> Name <email> <unix seconds> <tz>\t<message>", oldest first.
const REFLOG_LINE = /^[0-9a-f]+ [0-9a-f]+ .*? (\d+) [+-]\d{4}(?:\t(.*))?$/;
export function parseReflog(text) {
  return text.split('\n').flatMap((l) => {
    const m = REFLOG_LINE.exec(l);
    return m ? [{ t: Number(m[1]) * 1000, message: m[2] ?? '' }] : [];
  });
}

const CHECKOUT = /^checkout: moving from (.+) to (.+)$/;
const REBASE_RETURN = /^rebase\b.*: returning to refs\/heads\/(.+)$/;
const REBASE_START = /^rebase\b.*\(start\)/;
// Only these are new work. Amends rewrite, merges join, rebase picks replay.
const NEW_COMMIT = /^commit( \(initial\))?: /;
// A checkout target that is not a branch: a commit id, HEAD~n, @{-1}...
const COMMITISH = /^[0-9a-f]{7,64}$|^HEAD|[~^@]/;
const asBranch = (ref) => (COMMITISH.test(ref) ? DETACHED : ref);

// segments: [{t, branch}] (each holds from t until the next one); commits: [{t, branch}].
export function branchTimeline(entries, currentBranch) {
  if (!entries.length) return { segments: [], commits: [] };
  const firstCheckout = entries.map((e) => CHECKOUT.exec(e.message)).find(Boolean);
  let branch = firstCheckout ? asBranch(firstCheckout[1]) : currentBranch || UNKNOWN;
  const segments = [{ t: entries[0].t, branch }];
  const commits = [];
  for (const { t, message } of entries) {
    const co = CHECKOUT.exec(message);
    const back = REBASE_RETURN.exec(message);
    const next = co ? asBranch(co[2]) : back ? back[1] : REBASE_START.test(message) ? DETACHED : branch;
    if (next !== branch) {
      branch = next;
      if (segments.at(-1).t === t) segments.at(-1).branch = branch;
      else segments.push({ t, branch });
    }
    if (NEW_COMMIT.test(message)) commits.push({ t, branch });
  }
  return { segments, commits };
}

// The branch checked out at time t, or null before the reflog starts.
export function branchAt(segments, t) {
  let found = null;
  for (const s of segments) {
    if (s.t > t) break;
    found = s.branch;
  }
  return found;
}

// ---------- prices ----------

// Input price in USD per million tokens. Output is 5x, a 5-minute cache write 1.25x, a 1-hour write 2x, a cache read 0.1x.
const PRICES = [
  [/claude-3-opus|opus-4(-[01])?(-\d{8})?$/, 15], // Opus 3, 4 and 4.1
  [/opus/, 5], // Opus 4.5 and later
  [/sonnet/, 3],
  [/claude-3-haiku/, 0.25],
  [/3-5-haiku|haiku-3-5/, 0.8],
  [/haiku/, 1], // Haiku 4.5 and later
];
export function priceFor(model) {
  if (typeof model !== 'string') return null;
  return PRICES.find(([re]) => re.test(model))?.[1] ?? null;
}

export function callCost(usage, model) {
  const price = priceFor(model);
  if (price === null) return null;
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const write1h = n(usage.cache_creation?.ephemeral_1h_input_tokens);
  const write5m = Math.max(0, n(usage.cache_creation_input_tokens) - write1h);
  const weighted = n(usage.input_tokens) + 5 * n(usage.output_tokens) + 1.25 * write5m + 2 * write1h + 0.1 * n(usage.cache_read_input_tokens);
  return (weighted * price) / MICRO;
}

const totalTokens = (u) => ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
  .reduce((a, k) => a + (Number.isFinite(u[k]) && u[k] > 0 ? u[k] : 0), 0);

// ---------- Claude Code transcripts ----------

const inside = (cwd, root) => typeof cwd === 'string' && (cwd === root || cwd.startsWith(root + sep) || cwd.startsWith(`${root}/`));

// texts: transcript file contents (any iterable, so files can be read one at a time).
// Returns the repo's model calls: [{t, model, gitBranch, tokens, costUsd (null = no price)}].
export function parseTranscripts(texts, root) {
  const seen = new Set();
  const calls = [];
  for (const text of texts) {
    for (const l of text.split('\n')) {
      if (!l.trim()) continue;
      let e;
      try { e = JSON.parse(l); } catch { continue; } // a line cut off mid-write
      const usage = e?.message?.usage;
      const t = Date.parse(e?.timestamp);
      if (e?.type !== 'assistant' || !usage || typeof usage !== 'object' || !Number.isFinite(t) || !inside(e.cwd, root)) continue;
      // Claude Code writes one line per content block, all with the same usage: count each request once.
      const key = e.message.id && e.requestId ? `${e.message.id}:${e.requestId}` : e.uuid;
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      const model = e.message.model;
      calls.push({
        t,
        model,
        gitBranch: typeof e.gitBranch === 'string' ? e.gitBranch : '',
        tokens: totalTokens(usage),
        costUsd: Number.isFinite(e.costUSD) ? e.costUSD : callCost(usage, model),
      });
    }
  }
  return calls;
}

// ---------- calls + timeline -> rows ----------

// rows: [{date, branch, costUsd, tokens, commits}] sorted by date then branch; unpriced: models whose tokens cost $0 here.
export function attribute({ calls, timeline, since = null }) {
  const rows = new Map();
  const rowFor = (t, branch) => {
    const date = utcDate(t);
    if (since && date < since) return null;
    const key = `${date}\n${branch}`;
    if (!rows.has(key)) rows.set(key, { date, branch, costUsd: 0, tokens: 0, commits: 0 });
    return rows.get(key);
  };
  const unpriced = new Set();
  for (const c of calls) {
    // Git's record wins; before the reflog starts, use the branch Claude Code recorded ("HEAD" = detached).
    const recorded = c.gitBranch === 'HEAD' ? DETACHED : c.gitBranch || UNKNOWN;
    const r = rowFor(c.t, branchAt(timeline.segments, c.t) ?? recorded);
    if (!r) continue;
    r.tokens += c.tokens;
    if (c.costUsd === null) { if (c.tokens) unpriced.add(c.model); } else r.costUsd += c.costUsd;
  }
  for (const c of timeline.commits) {
    const r = rowFor(c.t, c.branch);
    if (r) r.commits++;
  }
  const sorted = [...rows.values()]
    .map((r) => ({ ...r, costUsd: round6(r.costUsd) }))
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0));
  return { rows: sorted, unpriced: [...unpriced].sort() };
}

// ---------- the repository and where its transcripts are ----------

// "owner/repo" from the origin remote (credentials never kept), else the folder name; fits the server's project rule.
export function projectLabel(remoteUrl, root) {
  let label = null;
  if (remoteUrl) {
    const path = remoteUrl.trim().replace(/^[a-z+]+:\/\/[^/]+\//i, '').replace(/^[^@/]+@[^:/]+:/, '').replace(/\.git$/, '').replace(/\/+$/, '');
    const parts = path.split('/').filter(Boolean);
    if (parts.length >= 2) label = parts.slice(-2).join('/');
  }
  label ??= basename(root);
  return label.replace(/[^\w.\-/ ]/g, '-').slice(0, 64) || 'default';
}

// Claude Code keeps each session under projects/<cwd with every non-alphanumeric character as '-'>.
const encodePath = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
export function transcriptFiles(claudeDirs, root) {
  const prefix = encodePath(root);
  return claudeDirs.flatMap((dir) => {
    const projects = join(dir, 'projects');
    if (!existsSync(projects)) return [];
    return readdirSync(projects, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (encodePath(d.name) === prefix || encodePath(d.name).startsWith(`${prefix}-`)))
      .flatMap((d) => readdirSync(join(projects, d.name), { withFileTypes: true })
        .filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
        .map((f) => join(projects, d.name, f.name)));
  });
}

async function git(args, cwd) {
  const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}
const gitOrNull = (args, cwd) => git(args, cwd).catch(() => null);

// Everything the CLI posts, for the repository at `repo`. Throws if `repo` isn't inside a git work tree.
export async function collect({ repo = process.cwd(), claudeDirs, since = null }) {
  let root;
  try {
    root = await git(['rev-parse', '--show-toplevel'], repo);
  } catch (e) {
    throw new Error(e.code === 'ENOENT' ? 'git is not installed or not on PATH' : `${resolve(repo)} is not a git repository (or any parent folder)`);
  }
  const warnings = [];
  const reflogPath = resolve(root, await git(['rev-parse', '--git-path', 'logs/HEAD'], root));
  const branch = await gitOrNull(['symbolic-ref', '--short', '-q', 'HEAD'], root);
  const remote = await gitOrNull(['remote', 'get-url', 'origin'], root);
  let entries = [];
  if (existsSync(reflogPath)) entries = parseReflog(readFileSync(reflogPath, 'utf8'));
  else warnings.push('No HEAD reflog in this repository (a fresh clone, or core.logAllRefUpdates is off): using the branch Claude Code recorded for each call.');
  // Transcripts are append-only: a file last written before `since` holds nothing newer, so it isn't read at all.
  // The rest are read one at a time, so a heavy user's months of logs never sit in memory together.
  const sinceMs = since ? Date.parse(`${since}T00:00:00Z`) : -Infinity;
  const files = transcriptFiles(claudeDirs, root).filter((f) => statSync(f).mtimeMs >= sinceMs);
  const calls = parseTranscripts((function* read() { for (const f of files) yield readFileSync(f, 'utf8'); })(), root);
  const { rows, unpriced } = attribute({ calls, timeline: branchTimeline(entries, branch), since });
  if (unpriced.length) warnings.push(`No price known for ${unpriced.join(', ')}: their tokens are counted, their cost is $0.`);
  return {
    root,
    project: projectLabel(remote, root),
    // Stable per machine and checkout, so a re-run replaces its own report and two developers add up. Not reversible.
    source: createHash('sha256').update(`${hostname()}\n${root}`).digest('hex').slice(0, 12),
    branch,
    calls: calls.length,
    files: files.length,
    rows,
    unpriced,
    warnings,
  };
}
