import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createSyncer, startScheduler } from '../src/sync.js';
import { createSlack } from '../src/slack.js';
import { fakeVendors, fakeMailer, fakeKey, fakeSlackHook, tmpFile } from './helpers.js';

const NOW = new Date('2026-10-05T12:00:00Z');

function setup({ usd = {}, connections = [], projects = {}, defaultSlackWebhookUrl = null, fetch, vendorDeadlineMs } = {}) {
  const store = createStore(tmpFile());
  store.update((s) => {
    connections.forEach((c, i) => s.connections.push({ id: `c${i}`, apiKey: fakeKey(`${c.tool}${i}`), org: c.tool === 'copilot' ? 'acme' : null, lastSyncAt: null, lastError: null, ...c }));
    Object.assign(s.projects, projects);
  });
  const f = fakeVendors(usd);
  const mailer = fakeMailer();
  const clock = { now: NOW };
  const syncer = createSyncer({ store, mailer, slack: createSlack({ fetch: f }), fetch: fetch ?? f, now: () => clock.now, defaultSlackWebhookUrl, vendorDeadlineMs });
  return { store, f, mailer, syncer, clock };
}
const budget = (monthlyUsd, email = 'lead@example.com', slackWebhookUrl = fakeSlackHook()) => ({ monthlyUsd, email, slackWebhookUrl });

test('a project budget counts every tool labelled with that project', async () => {
  const t = setup({
    usd: { claude: 30, openai: 30, cursor: 45 },
    connections: [{ tool: 'claude', project: 'acme' }, { tool: 'openai', project: 'acme' }, { tool: 'cursor', project: 'acme' }],
    projects: { acme: budget(100) },
  });
  const r = await t.syncer.run();
  assert.deepEqual(r.errors, []);
  assert.equal(t.mailer.sent.length, 1);
  assert.match(t.mailer.sent[0].subject, /acme reached 100%/);
  assert.match(t.mailer.sent[0].text, /\$105\.00/);
  for (const label of ['Claude', 'OpenAI', 'Cursor']) assert.match(t.mailer.sent[0].text, new RegExp(label));
  assert.equal(t.f.slack.length, 1);
});

test('only the project that is over its budget is alerted', async () => {
  const t = setup({
    usd: { claude: 150, openai: 10 },
    connections: [{ tool: 'claude', project: 'web' }, { tool: 'openai', project: 'api' }],
    projects: { web: budget(100, 'web@example.com'), api: budget(100, 'api@example.com', fakeSlackHook(2)) },
  });
  await t.syncer.run();
  assert.deepEqual(t.mailer.sent.map((m) => m.to), ['web@example.com']);
  assert.equal(t.f.slack.length, 1);
  assert.equal(t.f.slack[0].url, fakeSlackHook());
});

test('50%, 80% and 100% each alert once per channel as spend grows', async () => {
  const t = setup({ usd: { claude: 55 }, connections: [{ tool: 'claude', project: 'p' }], projects: { p: budget(100) } });
  await t.syncer.run();
  t.f.usd.claude = 60;
  await t.syncer.run();
  t.f.usd.claude = 85;
  await t.syncer.run();
  t.f.usd.claude = 101;
  await t.syncer.run();
  await t.syncer.run();
  assert.deepEqual(t.mailer.sent.map((m) => m.subject.match(/(\d+)%/)[1]), ['50', '80', '100']);
  assert.deepEqual(t.f.slack.map((m) => m.text.match(/reached (\d+)%/)[1]), ['50', '80', '100']);
});

test('jumping straight past the budget sends one 100% alert, not three', async () => {
  const t = setup({ usd: { openai: 150 }, connections: [{ tool: 'openai', project: 'p' }], projects: { p: budget(100) } });
  const r = await t.syncer.run();
  await t.syncer.run();
  assert.equal(t.mailer.sent.length, 1);
  assert.match(t.mailer.sent[0].subject, /100%/);
  assert.equal(t.f.slack.length, 1);
  assert.deepEqual(r.sent.map((s) => s.threshold), [100, 100]);
});

test('a Slack failure is retried on the next sync without re-sending the email', async () => {
  const t = setup({ usd: { claude: 120 }, connections: [{ tool: 'claude', project: 'p' }], projects: { p: budget(100) } });
  t.f.fail.slack = 500;
  const first = await t.syncer.run();
  assert.equal(t.mailer.sent.length, 1);
  assert.equal(t.f.slack.length, 0);
  assert.deepEqual(first.failed.map((x) => [x.channel, /500/.test(x.error)]), [['slack', true]]);
  t.f.fail.slack = 0;
  await t.syncer.run();
  assert.equal(t.f.slack.length, 1);
  assert.equal(t.mailer.sent.length, 1);
});

test('an email failure is retried on the next sync without re-posting to Slack', async () => {
  const t = setup({ usd: { claude: 120 }, connections: [{ tool: 'claude', project: 'p' }], projects: { p: budget(100) } });
  t.mailer.fail = true;
  await t.syncer.run();
  assert.equal(t.f.slack.length, 1);
  t.mailer.fail = false;
  await t.syncer.run();
  assert.equal(t.mailer.sent.length, 1);
  assert.equal(t.f.slack.length, 1);
});

test('one vendor failing does not stop the others, and its error never includes the key', async () => {
  const t = setup({
    usd: { claude: 120, openai: 5 },
    connections: [{ tool: 'claude', project: 'p' }, { tool: 'openai', project: 'p' }],
    projects: { p: budget(100) },
  });
  t.f.fail.openai = 401;
  const r = await t.syncer.run();
  assert.equal(t.mailer.sent.length, 1);
  assert.equal(t.f.slack.length, 1);
  assert.deepEqual(r.errors.map((e) => [e.tool, /401/.test(e.error)]), [['openai', true]]);
  const [claude, openai] = t.store.get().connections;
  assert.equal(claude.lastError, null);
  assert.equal(claude.lastSyncAt, NOW.toISOString());
  assert.match(openai.lastError, /OpenAI.*401/);
  assert.equal(openai.lastError.includes(openai.apiKey), false);
  assert.equal(openai.lastSyncAt, null);
});

test('the SLACK_WEBHOOK_URL default is used when a project has no webhook of its own', async () => {
  const hook = fakeSlackHook(9);
  const t = setup({ usd: { claude: 120 }, connections: [{ tool: 'claude', project: 'p' }], projects: { p: budget(100, 'a@b.co', null) }, defaultSlackWebhookUrl: hook });
  await t.syncer.run();
  assert.equal(t.f.slack.length, 1);
  assert.equal(t.f.slack[0].url, hook);
});

test('with no Slack webhook anywhere, alerts go by email only', async () => {
  const t = setup({ usd: { claude: 120 }, connections: [{ tool: 'claude', project: 'p' }], projects: { p: budget(100, 'a@b.co', null) } });
  const r = await t.syncer.run();
  assert.deepEqual(r.sent.map((s) => s.channel), ['email']);
  assert.equal(t.f.slack.length, 0);
});

test('a project without a budget, or a budget without connections, never alerts', async () => {
  const t = setup({ usd: { claude: 500 }, connections: [{ tool: 'claude', project: 'unbudgeted' }], projects: { empty: budget(1) } });
  const r = await t.syncer.run();
  assert.deepEqual(r.sent, []);
  assert.equal(t.mailer.sent.length, 0);
});

test('concurrent syncs (timer + button) send each alert once', async () => {
  const t = setup({ usd: { cursor: 120 }, connections: [{ tool: 'cursor', project: 'p' }], projects: { p: budget(100) } });
  await Promise.all([t.syncer.run(), t.syncer.run(), t.syncer.run()]);
  assert.equal(t.mailer.sent.length, 1);
  assert.equal(t.f.slack.length, 1);
});

test('a new month re-arms the alerts and only counts that month', async () => {
  const t = setup({ usd: { copilot: 120 }, connections: [{ tool: 'copilot', project: 'p' }], projects: { p: budget(100) } });
  await t.syncer.run();
  t.clock.now = new Date('2026-11-02T09:00:00Z');
  t.f.date = '2026-11-02';
  t.f.usd.copilot = 60;
  await t.syncer.run();
  assert.deepEqual(t.mailer.sent.map((m) => m.subject.match(/(\d+)%/)[1]), ['100', '50']);
  assert.match(t.mailer.sent[1].text, /2026-11/);
  assert.match(t.mailer.sent[1].text, /\$60\.00/);
});

test("the vendor window includes today, and later syncs re-fetch from the day before the last sync", async () => {
  const t = setup({ usd: { claude: 7 }, connections: [{ tool: 'claude', project: 'p' }] });
  await t.syncer.run();
  const first = new URL(t.f.calls[0].url);
  assert.equal(first.searchParams.get('starting_at'), '2026-10-01T00:00:00Z');
  assert.equal(first.searchParams.get('ending_at'), '2026-10-06T00:00:00Z');
  assert.deepEqual(t.store.get().usage.c0, { '2026-10-05': 7 });
  await t.syncer.run();
  assert.equal(new URL(t.f.calls[1].url).searchParams.get('starting_at'), '2026-10-04T00:00:00Z');
});

test('vendor fetches carry a timeout so a hung API cannot stall the timer', async () => {
  const t = setup({ connections: [{ tool: 'openai', project: 'p' }] });
  await t.syncer.run();
  assert.ok(t.f.calls[0].opts.signal instanceof AbortSignal);
});

test('a hung vendor is abandoned at the sync deadline and the other tools still alert', async () => {
  const inner = fakeVendors({ claude: 120 });
  const hangingCursor = (url, opts) => (String(url).includes('cursor')
    ? new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)))
    : inner(url, opts));
  const t = setup({
    connections: [{ tool: 'cursor', project: 'p' }, { tool: 'claude', project: 'p' }],
    projects: { p: budget(100, 'a@b.co', null) },
    fetch: hangingCursor,
    vendorDeadlineMs: 50,
  });
  const r = await t.syncer.run();
  assert.equal(t.mailer.sent.length, 1);
  assert.deepEqual(r.errors.map((e) => e.tool), ['cursor']);
  assert.match(r.errors[0].error, /timeout|abort/i);
});

test('a budget changed while its alert is being sent re-arms alerts for the new budget', async () => {
  const t = setup({ usd: { claude: 120 }, connections: [{ tool: 'claude', project: 'p' }], projects: { p: budget(100, 'a@b.co', null) } });
  const send = t.mailer.send;
  let changed = false;
  t.mailer.send = async (msg) => {
    await send(msg);
    if (!changed) { changed = true; t.store.update((s) => { s.projects.p = budget(130, 'a@b.co', null); }); }
  };
  await t.syncer.run();
  assert.match(t.mailer.sent[0].subject, /100%.*\$100\.00/);
  // $120 of the new $130 is 92%: the 80% alert for the new budget must still go out.
  await t.syncer.run();
  assert.equal(t.mailer.sent.length, 2);
  assert.match(t.mailer.sent[1].subject, /80%.*\$130\.00/);
});

test('malformed vendor rows are dropped before they reach the store', async () => {
  const body = {
    data: [
      { starting_at: '2026-10-03T00:00:00Z', results: [{ amount: '1000' }] },
      { starting_at: '<img src=x onerror=alert(1)>', results: [{ amount: '100' }] },
      { starting_at: '2026-10-04T00:00:00Z', results: [{ amount: '-500' }] },
      { starting_at: '2026-10-02T00:00:00Z', results: [{ amount: 'abc' }] },
    ],
    has_more: false,
  };
  const t = setup({ connections: [{ tool: 'claude', project: 'p' }], fetch: async () => ({ ok: true, status: 200, json: async () => body }) });
  await t.syncer.run();
  assert.deepEqual(t.store.get().usage.c0, { '2026-10-03': 10 });
});

test('a connection removed while its sync is in flight is not brought back', async () => {
  let release;
  let started;
  const gate = new Promise((r) => { release = r; });
  const fetching = new Promise((r) => { started = r; });
  const inner = fakeVendors({ claude: 9 });
  const t = setup({ connections: [{ tool: 'claude', project: 'p' }], fetch: async (...a) => { started(); await gate; return inner(...a); } });
  const running = t.syncer.run();
  await fetching;
  t.store.update((s) => { s.connections = []; delete s.usage.c0; });
  release();
  await running;
  assert.deepEqual(t.store.get().connections, []);
  assert.equal(t.store.get().usage.c0, undefined);
});

test('a connection re-keyed while its sync is in flight drops the old key\'s result', async () => {
  let release;
  let started;
  const gate = new Promise((r) => { release = r; });
  const fetching = new Promise((r) => { started = r; });
  const inner = fakeVendors({ claude: 9 });
  const t = setup({ connections: [{ tool: 'claude', project: 'p' }], fetch: async (...a) => { started(); await gate; return inner(...a); } });
  const running = t.syncer.run();
  await fetching;
  t.store.update((s) => { s.connections[0].apiKey = fakeKey('rotated'); });
  release();
  await running;
  assert.equal(t.store.get().usage.c0, undefined);
  assert.equal(t.store.get().connections[0].lastSyncAt, null);
});

test('a stored connection for an unknown tool is reported as an error, not a crash', async () => {
  const t = setup({ usd: { claude: 120 }, connections: [{ tool: 'gemini', project: 'p' }, { tool: 'claude', project: 'p' }], projects: { p: budget(100) } });
  const r = await t.syncer.run();
  assert.deepEqual(r.errors.map((e) => e.tool), ['gemini']);
  assert.equal(t.mailer.sent.length, 1);
});

test('scheduler runs at start, then every interval, skips ticks while a sync is running, and stops', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let runs = 0;
  let release;
  const run = () => { runs++; return new Promise((r) => { release = r; }); };
  const s = startScheduler(run, 1000);
  assert.equal(runs, 1);
  t.mock.timers.tick(1000);
  assert.equal(runs, 1, 'tick skipped while the first sync is still running');
  release();
  await s.idle();
  t.mock.timers.tick(1000);
  assert.equal(runs, 2);
  release();
  await s.idle();
  s.stop();
  t.mock.timers.tick(10_000);
  assert.equal(runs, 2);
});

test('scheduler logs a failed sync and keeps going', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const logs = [];
  let runs = 0;
  const s = startScheduler(async () => { runs++; throw new Error('boom'); }, 1000, (m) => logs.push(m));
  await s.idle();
  t.mock.timers.tick(1000);
  await s.idle();
  s.stop();
  assert.equal(runs, 2);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /boom/);
});
