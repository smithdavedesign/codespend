import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseReflog, branchTimeline, branchAt, parseTranscripts, priceFor, callCost, attribute, projectLabel, transcriptFiles, collect,
  UNKNOWN, DETACHED,
} from '../src/attribution.js';
import { makeRepo, writeTranscripts, knownCalls, claudeCall, tmpDir, KNOWN_REPO_STEPS, KNOWN_BREAKDOWN } from './repo-fixture.js';

const Z = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const sec = (iso) => Date.parse(iso) / 1000;
const line = (iso, msg, who = 'Sample Dev <dev@example.com>') => `${Z} ${A} ${who} ${sec(iso)} +0200\t${msg}`;
const ms = (iso) => Date.parse(iso);
const cents = (n) => Math.round(n * 100);
const micros = (n) => Math.round(n * 1e6);

test('parseReflog: timestamps and messages, oldest first; names with digits and spaces, tabs in messages, junk lines', () => {
  const text = [
    line('2026-10-05T09:00:00Z', 'commit (initial): init', 'Dev 2 Smith 3 <d@example.com>'),
    'not a reflog line',
    '',
    line('2026-10-05T09:30:00Z', 'checkout: moving from main to feature/x'),
    line('2026-10-05T10:00:00Z', 'commit: has\ta tab'),
    `${Z} ${A} No Message <n@example.com> ${sec('2026-10-05T10:30:00Z')} +0000`,
  ].join('\n');
  assert.deepEqual(parseReflog(text), [
    { t: ms('2026-10-05T09:00:00Z'), message: 'commit (initial): init' },
    { t: ms('2026-10-05T09:30:00Z'), message: 'checkout: moving from main to feature/x' },
    { t: ms('2026-10-05T10:00:00Z'), message: 'commit: has\ta tab' },
    { t: ms('2026-10-05T10:30:00Z'), message: '' },
  ]);
  assert.deepEqual(parseReflog(''), []);
});

test('branchTimeline: the branch before the first checkout is that checkout\'s "from"; checkouts switch; commits land on the current branch', () => {
  const entries = parseReflog([
    line('2026-10-05T09:00:00Z', 'commit (initial): init'),
    line('2026-10-05T09:30:00Z', 'checkout: moving from main to feature/x'),
    line('2026-10-05T10:00:00Z', 'commit: work'),
    line('2026-10-05T10:05:00Z', 'commit (amend): work, reworded'),
    line('2026-10-05T11:00:00Z', 'checkout: moving from feature/x to main'),
    line('2026-10-05T11:10:00Z', 'merge feature/x: Fast-forward'),
    line('2026-10-05T11:20:00Z', 'commit (merge): Merge branch hotfix'),
    line('2026-10-05T11:30:00Z', 'commit: on main'),
  ].join('\n'));
  const tl = branchTimeline(entries, 'main');
  assert.deepEqual(tl.segments, [
    { t: ms('2026-10-05T09:00:00Z'), branch: 'main' },
    { t: ms('2026-10-05T09:30:00Z'), branch: 'feature/x' },
    { t: ms('2026-10-05T11:00:00Z'), branch: 'main' },
  ]);
  // Amends rewrite a commit and merges join branches: neither is new work.
  assert.deepEqual(tl.commits, [
    { t: ms('2026-10-05T09:00:00Z'), branch: 'main' },
    { t: ms('2026-10-05T10:00:00Z'), branch: 'feature/x' },
    { t: ms('2026-10-05T11:30:00Z'), branch: 'main' },
  ]);
});

test('branchTimeline: with no checkout at all, everything is on the current branch', () => {
  const tl = branchTimeline(parseReflog([line('2026-10-05T09:00:00Z', 'commit (initial): a'), line('2026-10-05T10:00:00Z', 'commit: b')].join('\n')), 'trunk');
  assert.deepEqual(tl.segments, [{ t: ms('2026-10-05T09:00:00Z'), branch: 'trunk' }]);
  assert.deepEqual(tl.commits.map((c) => c.branch), ['trunk', 'trunk']);
  assert.deepEqual(branchTimeline([], 'main'), { segments: [], commits: [] });
  // Detached right now and never checked out: the branch is unknown rather than guessed.
  assert.equal(branchTimeline(parseReflog(line('2026-10-05T09:00:00Z', 'commit (initial): a')), null).segments[0].branch, UNKNOWN);
});

test('branchTimeline: checking out a commit id or HEAD~n is detached; a rebase is detached until it returns to its branch', () => {
  const tl = branchTimeline(parseReflog([
    line('2026-10-05T09:00:00Z', `checkout: moving from main to ${B}`),
    line('2026-10-05T09:10:00Z', 'checkout: moving from bbbbbbb to feature/y'),
    line('2026-10-05T09:20:00Z', 'checkout: moving from feature/y to HEAD~2'),
    line('2026-10-05T09:30:00Z', `checkout: moving from ${A} to feature/y`),
    line('2026-10-05T10:00:00Z', 'rebase (start): checkout main'),
    line('2026-10-05T10:00:01Z', 'rebase (pick): work'),
    line('2026-10-05T10:00:02Z', 'rebase (finish): returning to refs/heads/feature/y'),
    line('2026-10-05T10:30:00Z', 'rebase -i (start): checkout HEAD~3'),
    line('2026-10-05T10:31:00Z', 'rebase -i (abort): returning to refs/heads/feature/y'),
  ].join('\n')), 'feature/y');
  // The first entry is itself a checkout, so the zero-length "main" segment before it is replaced, not kept.
  assert.deepEqual(tl.segments.map((s) => s.branch), [DETACHED, 'feature/y', DETACHED, 'feature/y', DETACHED, 'feature/y', DETACHED, 'feature/y']);
  assert.equal(tl.segments[0].t, ms('2026-10-05T09:00:00Z'));
  assert.deepEqual(tl.commits, []); // rebase picks are rewrites, not new commits
});

test('branchAt: null before the reflog starts, the new branch from the switch instant on, the last branch afterwards', () => {
  const segments = [{ t: 100, branch: 'main' }, { t: 200, branch: 'feature' }];
  assert.equal(branchAt(segments, 99), null);
  assert.equal(branchAt(segments, 100), 'main');
  assert.equal(branchAt(segments, 199), 'main');
  assert.equal(branchAt(segments, 200), 'feature');
  assert.equal(branchAt(segments, 10_000), 'feature');
  assert.equal(branchAt([], 100), null);
});

test('priceFor: input $/million tokens per Claude family, including legacy Opus and Haiku; unknown models have no price', () => {
  assert.equal(priceFor('claude-opus-4-20250514'), 15);
  assert.equal(priceFor('claude-opus-4-1-20250805'), 15);
  assert.equal(priceFor('claude-opus-4-1'), 15);
  assert.equal(priceFor('claude-3-opus-20240229'), 15);
  assert.equal(priceFor('claude-opus-4-5-20251101'), 5);
  assert.equal(priceFor('claude-opus-5-5'), 5);
  assert.equal(priceFor('claude-sonnet-4-5-20250929'), 3);
  assert.equal(priceFor('claude-3-7-sonnet-20250219'), 3);
  assert.equal(priceFor('claude-sonnet-5-5'), 3);
  assert.equal(priceFor('claude-haiku-4-5-20251001'), 1);
  assert.equal(priceFor('claude-3-5-haiku-20241022'), 0.8);
  assert.equal(priceFor('claude-3-haiku-20240307'), 0.25);
  assert.equal(priceFor('gpt-5'), null);
  assert.equal(priceFor('<synthetic>'), null);
  assert.equal(priceFor(undefined), null);
});

test('callCost: output 5x, 5-minute cache write 1.25x, 1-hour cache write 2x, cache read 0.1x the input price', () => {
  const u = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 3_000_000, cache_read_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 2_000_000 } };
  // Sonnet ($3): 3 + 15 + 3.75 + 2*6 + 0.3
  assert.equal(cents(callCost(u, 'claude-sonnet-4-5')), cents(3 + 15 + 3.75 + 12 + 0.3));
  // Without the 5m/1h split, all cache writes are 5-minute ones.
  assert.equal(cents(callCost({ cache_creation_input_tokens: 1_000_000 }, 'claude-sonnet-4-5')), 375);
  assert.equal(callCost({ input_tokens: 10 }, 'mystery-model'), null);
});

test('parseTranscripts: assistant calls inside the repo only, deduped per message and request; junk and non-usage lines skipped', () => {
  const root = '/work/acme-web';
  const calls = parseTranscripts([knownCalls(root).map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')], root);
  // 6 priced calls: the duplicate, the user line, the other repo and the truncated line are gone.
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.map((c) => micros(c.costUsd)), [450_000, 900_000, 300_000, 200_000, 1_650_000, 225_000]);
  assert.deepEqual(calls.map((c) => c.gitBranch), ['main', 'feature/login', 'feature/login', 'feature/login', 'feature/login', 'main']);
  assert.equal(calls[0].t, ms('2026-10-05T09:10:00Z'));
  assert.equal(calls[0].tokens, 110_000);
  assert.equal(calls[0].model, 'claude-sonnet-4-5-20250929');

  // The same call in two files (a resumed session) still counts once; a sibling folder with the same prefix doesn't count.
  const c = claudeCall({ at: '2026-10-05T09:00:00Z', cwd: root, input: 1000 });
  const sibling = claudeCall({ at: '2026-10-05T09:00:00Z', cwd: '/work/acme-web2', input: 1000 });
  assert.equal(parseTranscripts([JSON.stringify(c), `${JSON.stringify(c)}\n${JSON.stringify(sibling)}`], root).length, 1);
  // Lines without usage, a timestamp or a cwd are not calls.
  const noUsage = { ...c, message: { ...c.message, usage: undefined } };
  assert.equal(parseTranscripts([[noUsage, { ...c, timestamp: 'nope', requestId: 'x' }, { ...c, cwd: undefined, requestId: 'y' }].map((l) => JSON.stringify(l)).join('\n')], root).length, 0);
});

test('parseTranscripts: a costUSD written by Claude Code wins over the price table; unknown models cost null', () => {
  const root = '/r';
  const [withCost, unknown] = parseTranscripts([[
    claudeCall({ at: '2026-10-05T09:00:00Z', cwd: root, input: 1_000_000, costUSD: 0.42 }),
    claudeCall({ at: '2026-10-05T09:00:00Z', cwd: root, model: 'claude-fable-5-1', input: 500 }),
  ].map((l) => JSON.stringify(l)).join('\n')], root);
  assert.equal(withCost.costUsd, 0.42);
  assert.equal(unknown.costUsd, null);
  assert.equal(unknown.tokens, 500);
});

test('attribute: each call goes to the branch checked out at its time; commits per branch; rows per UTC day and branch', () => {
  const timeline = { segments: [{ t: ms('2026-10-05T09:00:00Z'), branch: 'main' }, { t: ms('2026-10-05T23:00:00Z'), branch: 'feat' }], commits: [{ t: ms('2026-10-05T09:00:00Z'), branch: 'main' }, { t: ms('2026-10-06T01:00:00Z'), branch: 'feat' }] };
  const calls = [
    { t: ms('2026-10-05T08:00:00Z'), gitBranch: 'old-session', model: 'm', tokens: 1, costUsd: 1 }, // before the reflog: the transcript's branch
    { t: ms('2026-10-05T08:30:00Z'), gitBranch: '', model: 'm', tokens: 1, costUsd: 1 }, // before the reflog, no branch recorded
    { t: ms('2026-10-05T08:40:00Z'), gitBranch: 'HEAD', model: 'm', tokens: 1, costUsd: 1 }, // Claude Code's name for a detached HEAD
    { t: ms('2026-10-05T10:00:00Z'), gitBranch: 'stale', model: 'm', tokens: 10, costUsd: 2 },
    { t: ms('2026-10-05T23:30:00Z'), gitBranch: 'feat', model: 'm', tokens: 5, costUsd: 4 },
    { t: ms('2026-10-06T00:30:00Z'), gitBranch: 'feat', model: 'm', tokens: 5, costUsd: 8 },
    { t: ms('2026-10-06T00:40:00Z'), gitBranch: 'feat', model: 'claude-fable-5-1', tokens: 7, costUsd: null },
    { t: ms('2026-10-06T00:50:00Z'), gitBranch: 'feat', model: '<synthetic>', tokens: 0, costUsd: null },
  ];
  const { rows, unpriced } = attribute({ calls, timeline });
  assert.deepEqual(rows, [
    { date: '2026-10-05', branch: DETACHED, costUsd: 1, tokens: 1, commits: 0 },
    { date: '2026-10-05', branch: UNKNOWN, costUsd: 1, tokens: 1, commits: 0 },
    { date: '2026-10-05', branch: 'feat', costUsd: 4, tokens: 5, commits: 0 },
    { date: '2026-10-05', branch: 'main', costUsd: 2, tokens: 10, commits: 1 },
    { date: '2026-10-05', branch: 'old-session', costUsd: 1, tokens: 1, commits: 0 },
    { date: '2026-10-06', branch: 'feat', costUsd: 8, tokens: 12, commits: 1 },
  ]);
  assert.deepEqual(unpriced, ['claude-fable-5-1']);
  // since drops earlier calls and commits.
  assert.deepEqual(attribute({ calls, timeline, since: '2026-10-06' }).rows.map((r) => r.date), ['2026-10-06']);
});

test('projectLabel: owner/repo from https and ssh remotes (never the credentials), else the folder name', () => {
  assert.equal(projectLabel('https://github.com/acme/web.git', '/x/y'), 'acme/web');
  assert.equal(projectLabel('git@github.com:acme/web.git', '/x/y'), 'acme/web');
  assert.equal(projectLabel('ssh://git@gitlab.example.com:2222/group/sub/repo.git', '/x/y'), 'sub/repo');
  assert.equal(projectLabel(['https://user', 'tok3n'.repeat(4) + '@github.com/acme/api'].join(':'), '/x/y'), 'acme/api');
  assert.equal(projectLabel(null, '/home/dev/my app'), 'my app');
  assert.equal(projectLabel(null, '/home/dev/odd#name!'), 'odd-name-');
  assert.equal(projectLabel(null, `/home/${'x'.repeat(80)}`).length, 64);
});

test('transcriptFiles: the folders Claude Code made for the repo and its subfolders, in every config dir given', () => {
  const root = '/work/acme.web';
  const a = tmpDir('cs-claude-');
  const b = tmpDir('cs-claude-');
  writeTranscripts(a, root, { s1: ['{}'] });
  writeTranscripts(a, `${root}/packages/api`, { s2: ['{}'] });
  writeTranscripts(a, '/work/other', { s3: ['{}'] });
  writeTranscripts(b, root, { s4: ['{}'] });
  mkdirSync(join(a, 'projects', '-work-acme-web', 'notes'), { recursive: true });
  writeFileSync(join(a, 'projects', '-work-acme-web', 'readme.txt'), 'x');
  const files = transcriptFiles([a, b, join(a, 'missing')], root).map((f) => f.split('/').slice(-1)[0]).sort();
  assert.deepEqual(files, ['s1.jsonl', 's2.jsonl', 's4.jsonl']);
});

test('collect: a real repository and its transcripts give the known per-branch rows, project, source id and current branch', async () => {
  const repo = makeRepo(KNOWN_REPO_STEPS);
  const claudeDir = tmpDir('cs-claude-');
  writeTranscripts(claudeDir, repo.dir, { 'session-1': knownCalls(repo.dir) });
  const r = await collect({ repo: repo.dir, claudeDirs: [claudeDir], since: '2026-10-01' });
  assert.equal(r.root, repo.dir);
  assert.equal(r.project, 'acme/web');
  assert.equal(r.branch, 'main');
  assert.match(r.source, /^[0-9a-f]{12}$/);
  assert.equal(r.calls, 6);
  assert.deepEqual(r.warnings, []);
  const byBranch = Object.fromEntries(r.rows.map((x) => [x.branch, { usd: micros(x.costUsd), tokens: x.tokens, commits: x.commits }]));
  assert.deepEqual(byBranch, Object.fromEntries(KNOWN_BREAKDOWN.map((b) => [b.branch, { usd: micros(b.costUsd), tokens: b.tokens, commits: b.commits }])));
  // Same machine and repo -> same source id, so a re-run replaces its own report.
  assert.equal((await collect({ repo: repo.dir, claudeDirs: [claudeDir], since: '2026-10-01' })).source, r.source);
});

test('collect: without a reflog it falls back to the branch Claude Code recorded, and warns', async () => {
  const repo = makeRepo([{ at: '2026-10-05T09:00:00Z', commit: 'init' }]);
  rmSync(join(repo.dir, '.git', 'logs'), { recursive: true });
  const claudeDir = tmpDir('cs-claude-');
  writeTranscripts(claudeDir, repo.dir, { s: [claudeCall({ at: '2026-10-05T10:00:00Z', cwd: repo.dir, gitBranch: 'feature/q', input: 1_000_000 })] });
  const r = await collect({ repo: repo.dir, claudeDirs: [claudeDir] , since: '2026-10-01' });
  assert.deepEqual(r.rows, [{ date: '2026-10-05', branch: 'feature/q', costUsd: 3, tokens: 1_000_000, commits: 0 }]);
  assert.equal(r.project, repo.dir.split('/').at(-1));
  assert.match(r.warnings.join('\n'), /reflog/i);
});

test('collect: transcript files last written before --since are not read (they cannot hold newer calls)', async () => {
  const repo = makeRepo([{ at: '2026-10-05T09:00:00Z', commit: 'init' }]);
  const claudeDir = tmpDir('cs-claude-');
  const dir = writeTranscripts(claudeDir, repo.dir, {
    old: [claudeCall({ at: '2026-10-05T10:00:00Z', cwd: repo.dir, input: 1_000_000 })],
    fresh: [claudeCall({ at: '2026-10-05T11:00:00Z', cwd: repo.dir, input: 2_000_000 })],
  });
  const before = new Date('2026-09-20T00:00:00Z');
  utimesSync(join(dir, 'old.jsonl'), before, before);
  const r = await collect({ repo: repo.dir, claudeDirs: [claudeDir], since: '2026-10-01' });
  assert.equal(r.files, 1);
  assert.deepEqual(r.rows.map((x) => [x.date, x.costUsd]), [['2026-10-05', 6]]);
});

test('collect: outside a git repository it fails with a clear message', async () => {
  await assert.rejects(collect({ repo: tmpDir('cs-norepo-'), claudeDirs: [] }), /not a git repository/i);
});
