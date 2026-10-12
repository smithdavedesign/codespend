// Real git repositories and Claude Code transcripts for the branch-attribution tests (and the screenshot run).
// Every git step runs with fixed author/committer dates, so the HEAD reflog has known timestamps.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Isolated from the machine's git config: no global/system settings, hooks or signing leak into the fixture.
export const GIT_ENV = {
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Sample Dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'Sample Dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
};

export const tmpDir = (prefix = 'cs-') => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

// steps: { at, commit: 'msg' } | { at, branch: 'name', from? } (create + check out) | { at, checkout: 'name' } | { remote: 'url' }
export function makeRepo(steps, { dir = tmpDir('cs-repo-'), initialBranch = 'main' } = {}) {
  const git = (args, at = '2026-01-01T00:00:00Z') => execFileSync('git', args, {
    cwd: dir,
    env: { ...process.env, ...GIT_ENV, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  git(['init', '-q']);
  git(['symbolic-ref', 'HEAD', `refs/heads/${initialBranch}`]);
  for (const s of steps) {
    if (s.commit) git(['commit', '-q', '--allow-empty', '-m', s.commit], s.at);
    else if (s.branch) git(['checkout', '-q', '-b', s.branch, ...(s.from ? [s.from] : [])], s.at);
    else if (s.checkout) git(['checkout', '-q', s.checkout], s.at);
    else if (s.remote) git(['remote', 'add', 'origin', s.remote]);
  }
  return { dir, git };
}

// One Claude Code assistant line, in the shape Claude Code writes to ~/.claude/projects/<encoded cwd>/<session>.jsonl.
export function claudeCall({ at, cwd, gitBranch, model = 'claude-sonnet-4-5-20250929', input = 0, output = 0, cacheWrite = 0, cacheWrite1h = 0, cacheRead = 0, id = `msg_${randomUUID()}`, requestId = `req_${randomUUID()}`, costUSD, sessionId = 'session-1' }) {
  const usage = {
    input_tokens: input,
    cache_creation_input_tokens: cacheWrite + cacheWrite1h,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
    service_tier: 'standard',
  };
  if (cacheWrite1h) usage.cache_creation = { ephemeral_5m_input_tokens: cacheWrite, ephemeral_1h_input_tokens: cacheWrite1h };
  return {
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd,
    sessionId,
    version: '2.0.14',
    gitBranch,
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: at,
    requestId,
    ...(costUSD === undefined ? {} : { costUSD }),
    message: { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'Sample reply.' }], stop_reason: 'end_turn', usage },
  };
}

export const userLine = ({ at, cwd, gitBranch }) => ({ type: 'user', cwd, gitBranch, timestamp: at, uuid: randomUUID(), message: { role: 'user', content: 'Sample prompt.' } });

// Claude Code names each project folder after its working directory with every non-alphanumeric character as '-'.
export const encodePath = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

// Writes {session: [lines]} under <claudeDir>/projects/<encoded folder>/. Lines may be objects or raw strings.
export function writeTranscripts(claudeDir, folder, sessions) {
  const dir = join(claudeDir, 'projects', encodePath(folder));
  mkdirSync(dir, { recursive: true });
  for (const [name, lines] of Object.entries(sessions)) {
    writeFileSync(join(dir, `${name}.jsonl`), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  }
  return dir;
}

// The exit-criterion repository: known commits on three branches, on 2026-10-05 (UTC).
//   09:00 main: initial commit            10:30, 11:00 feature/login commits    11:45 fix/typo commit
//   09:30 -> feature/login    11:15 -> fix/typo (from main)    12:00 -> feature/login    13:00 commit    13:30 -> main
export const KNOWN_REPO_STEPS = [
  { remote: 'https://github.com/acme/web.git' },
  { at: '2026-10-05T09:00:00Z', commit: 'init' },
  { at: '2026-10-05T09:30:00Z', branch: 'feature/login' },
  { at: '2026-10-05T10:30:00Z', commit: 'login form' },
  { at: '2026-10-05T11:00:00Z', commit: 'login api' },
  { at: '2026-10-05T11:15:00Z', branch: 'fix/typo', from: 'main' },
  { at: '2026-10-05T11:45:00Z', commit: 'fix typo' },
  { at: '2026-10-05T12:00:00Z', checkout: 'feature/login' },
  { at: '2026-10-05T13:00:00Z', commit: 'login tests' },
  { at: '2026-10-05T13:30:00Z', checkout: 'main' },
];

// Calls made while the repo above was being worked on, with the dollars each one costs at list price.
export function knownCalls(root) {
  const dup = claudeCall({ at: '2026-10-05T10:00:00Z', cwd: join(root, 'src'), gitBranch: 'feature/login', input: 200_000, output: 20_000 });
  return [
    // main: $0.45 (Sonnet: 100k in at $3/M + 10k out at $15/M)
    claudeCall({ at: '2026-10-05T09:10:00Z', cwd: root, gitBranch: 'main', input: 100_000, output: 10_000 }),
    userLine({ at: '2026-10-05T09:59:00Z', cwd: root, gitBranch: 'feature/login' }),
    // feature/login: $0.90, from a subdirectory; Claude Code writes one line per content block, so it appears twice
    dup,
    { ...dup, uuid: randomUUID() },
    // feature/login: $0.30 (Opus 4.1: 10k in at $15/M + 2k out at $75/M)
    claudeCall({ at: '2026-10-05T10:45:00Z', cwd: root, gitBranch: 'feature/login', model: 'claude-opus-4-1-20250805', input: 10_000, output: 2_000 }),
    // fix/typo: $0.20 (Haiku 4.5: 100k in at $1/M + 1M cache read at $0.10/M). The transcript's gitBranch is stale; the reflog wins.
    claudeCall({ at: '2026-10-05T11:30:00Z', cwd: root, gitBranch: 'feature/login', model: 'claude-haiku-4-5-20251001', input: 100_000, cacheRead: 1_000_000 }),
    // another repository's call in the same transcript: must not count ($75)
    claudeCall({ at: '2026-10-05T12:10:00Z', cwd: `${root}-other`, gitBranch: 'feature/login', model: 'claude-opus-4-1-20250805', output: 1_000_000 }),
    // feature/login: $1.65 (Sonnet: 400k cache write at $3.75/M + 10k out at $15/M)
    claudeCall({ at: '2026-10-05T12:30:00Z', cwd: root, gitBranch: 'feature/login', cacheWrite: 400_000, output: 10_000 }),
    '{"type":"assistant","truncated', // a line cut off mid-write
    // main: $0.225 (Sonnet: 50k in + 5k out)
    claudeCall({ at: '2026-10-05T13:45:00Z', cwd: root, gitBranch: 'main', input: 50_000, output: 5_000 }),
  ];
}

// What the attribution view must show for the repository and calls above.
export const KNOWN_BREAKDOWN = [
  { branch: 'feature/login', costUsd: 2.85, tokens: 642_000, commits: 3 },
  { branch: 'main', costUsd: 0.675, tokens: 165_000, commits: 1 },
  { branch: 'fix/typo', costUsd: 0.2, tokens: 1_100_000, commits: 1 },
];
