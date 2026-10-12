import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.js';
import { fakeMailer, fakeVendors, startApp, tmpFile } from './helpers.js';
import { makeRepo, writeTranscripts, knownCalls, tmpDir, GIT_ENV, KNOWN_REPO_STEPS } from './repo-fixture.js';

const CLI = fileURLToPath(new URL('../bin/codespend-branches.mjs', import.meta.url));

// Resolves with {code, stdout, stderr} whatever the exit code.
function cli(args, { cwd, claudeDir }) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...GIT_ENV, CLAUDE_CONFIG_DIR: claudeDir } }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

// A port that nothing listens on.
async function closedPort() {
  const s = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

function fixture() {
  const repo = makeRepo(KNOWN_REPO_STEPS);
  const claudeDir = tmpDir('cs-claude-');
  writeTranscripts(claudeDir, repo.dir, { s: knownCalls(repo.dir) });
  return { cwd: repo.dir, claudeDir };
}

test('--dry-run prints the per-branch breakdown and posts nothing', async () => {
  const f = fixture();
  const r = await cli(['--dry-run', '--since', '2026-10-01', '--server', `http://127.0.0.1:${await closedPort()}`], f);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /acme\/web/);
  assert.match(r.stdout, /feature\/login\s+\$2\.85\s+642,000 tokens\s+3 commits/);
  assert.match(r.stdout, /fix\/typo\s+\$0\.20/);
  assert.match(r.stdout, /dry run/i);
});

test('--repo works from any directory, and --project overrides the label from the remote', async () => {
  const f = fixture();
  const store = createStore(tmpFile());
  const app = await startApp({ store, mailer: fakeMailer(), fetch: fakeVendors(), now: () => new Date('2026-10-05T14:00:00Z') });
  try {
    const r = await cli(['--repo', f.cwd, '--project', 'web-app', '--since', '2026-10-01', '--server', `http://127.0.0.1:${app.server.address().port}`], { cwd: tmpDir(), claudeDir: f.claudeDir });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(Object.keys(store.get().branches), ['web-app']);
  } finally { await app.close(); }
});

test('outside a git repository the CLI exits 1 and says why', async () => {
  const r = await cli(['--dry-run'], { cwd: tmpDir('cs-norepo-'), claudeDir: tmpDir() });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a git repository/i);
});

test('an unreachable server or a rejected report exits 1', async () => {
  const f = fixture();
  const down = await cli(['--since', '2026-10-01', '--server', `http://127.0.0.1:${await closedPort()}`], f);
  assert.equal(down.code, 1);
  assert.match(down.stderr, /could not reach/i);

  const app = await startApp({ store: createStore(tmpFile()), mailer: fakeMailer(), fetch: fakeVendors() });
  try {
    const bad = await cli(['--project', 'bad|label', '--since', '2026-10-01', '--server', `http://127.0.0.1:${app.server.address().port}`], f);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /400/);
    assert.match(bad.stderr, /project/);
  } finally { await app.close(); }
});

test('bad options exit 1 with usage help', async () => {
  const f = fixture();
  const r = await cli(['--since', 'last-week'], f);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /since/);
  const h = await cli(['--help'], f);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /Usage/);
});
