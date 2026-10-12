// M3 exit criterion: the attribution view shows the correct branch breakdown for a test repository with known commits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.js';
import { fakeMailer, fakeVendors, startApp, tmpFile } from './helpers.js';
import { makeRepo, writeTranscripts, knownCalls, tmpDir, GIT_ENV, KNOWN_REPO_STEPS, KNOWN_BREAKDOWN } from './repo-fixture.js';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/codespend-branches.mjs', import.meta.url));
const NOW = new Date('2026-10-05T14:00:00Z');
const micros = (n) => Math.round(n * 1e6);

async function setup() {
  const repo = makeRepo(KNOWN_REPO_STEPS);
  const claudeDir = tmpDir('cs-claude-');
  writeTranscripts(claudeDir, repo.dir, { 'session-1': knownCalls(repo.dir) });
  const app = await startApp({ store: createStore(tmpFile()), mailer: fakeMailer(), fetch: fakeVendors(), now: () => NOW });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  // The real CLI, run the way a developer would: inside their repo, pointed at the CodeSpend server.
  const cli = (...args) => run(process.execPath, [CLI, '--server', base, '--since', '2026-10-01', ...args], {
    cwd: repo.dir,
    env: { ...process.env, ...GIT_ENV, CLAUDE_CONFIG_DIR: claudeDir },
  });
  return { repo, app, cli };
}

const shape = (b) => ({ branch: b.branch, usd: micros(b.costUsd), tokens: b.tokens, commits: b.commits });

test('exit: the attribution view shows the correct branch breakdown for a test repository with known commits', async () => {
  const { app, cli } = await setup();
  try {
    const out = await cli();
    assert.match(out.stdout, /acme\/web/);
    assert.match(out.stdout, /feature\/login/);

    const view = await app.call('GET', '/api/branches?project=acme/web&from=2026-10-01&to=2026-10-31');
    assert.equal(view.status, 200);
    const v = view.body;
    assert.equal(v.project, 'acme/web');
    // Ordered by spend; each branch's dollars, tokens and commits match the repository's known history.
    assert.deepEqual(v.branches.map(shape), KNOWN_BREAKDOWN.map(shape));
    assert.equal(micros(v.totalUsd), micros(3.725));
    assert.equal(v.commits, 5);
    assert.equal(Math.round(v.branches.reduce((a, b) => a + b.sharePct, 0)), 100);
    assert.equal(Math.round(v.branches[0].sharePct), 77);
    assert.deepEqual(v.branches[0].days.map((d) => [d.date, micros(d.costUsd)]), [['2026-10-05', 2_850_000]]);
    assert.ok(v.reportedAt);

    // With no project given, the view opens on the only project that has branch data.
    assert.deepEqual((await app.call('GET', '/api/branches?from=2026-10-01&to=2026-10-31')).body.branches.map(shape), KNOWN_BREAKDOWN.map(shape));
    // The page has the attribution view that renders this data.
    const page = await app.call('GET', '/');
    assert.match(page.body, /id="branches"/);
  } finally { await app.close(); }
});

test('exit: running the CLI again replaces its report instead of double counting', async () => {
  const { app, cli } = await setup();
  try {
    await cli();
    await cli();
    const v = (await app.call('GET', '/api/branches?project=acme/web&from=2026-10-01&to=2026-10-31')).body;
    assert.deepEqual(v.branches.map(shape), KNOWN_BREAKDOWN.map(shape));
  } finally { await app.close(); }
});
