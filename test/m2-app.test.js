import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createStore } from '../src/store.js';
import { fakeVendors, fakeMailer, fakeKey, fakeSlackHook, startApp, tmpFile } from './helpers.js';

const NOW = new Date('2026-10-05T12:00:00Z');

async function setup(usd = {}, opts = {}) {
  const f = fakeVendors(usd);
  const mailer = fakeMailer();
  const store = createStore(tmpFile());
  const app = await startApp({ store, mailer, fetch: f, now: () => NOW, ...opts });
  return { ...app, f, mailer, store };
}

test('unified dashboard: spend this month by tool, by project label and by day, across all four tools', async () => {
  const t = await setup({ claude: 10, openai: 20, copilot: 30, cursor: 40 });
  try {
    assert.equal((await t.call('POST', '/api/connections', { tool: 'claude', apiKey: fakeKey('a'), project: 'acme/web' })).status, 201);
    assert.equal((await t.call('POST', '/api/connections', { tool: 'openai', apiKey: fakeKey('b'), project: 'acme/web' })).status, 201);
    assert.equal((await t.call('POST', '/api/connections', { tool: 'copilot', apiKey: fakeKey('c'), org: 'acme', project: 'platform' })).status, 201);
    assert.equal((await t.call('POST', '/api/connections', { tool: 'cursor', apiKey: fakeKey('d'), project: 'platform' })).status, 201);
    await t.call('POST', '/api/budget', { project: 'platform', monthlyUsd: 200, email: 'ops@example.com' });
    assert.equal((await t.call('POST', '/api/sync')).status, 200);

    const d = (await t.call('GET', '/api/usage')).body;
    assert.equal(d.month, '2026-10');
    assert.equal(d.totalUsd, 100);
    assert.deepEqual(Object.fromEntries(d.tools.map((x) => [x.tool, x.monthUsd])), { claude: 10, openai: 20, copilot: 30, cursor: 40 });
    assert.deepEqual(d.tools.find((x) => x.tool === 'cursor').days, [{ date: '2026-10-05', costUsd: 40 }]);
    assert.ok(d.tools.every((x) => x.connected && x.label));
    assert.deepEqual(d.projects.map((p) => [p.name, p.spend, p.budget]), [['acme/web', 30, null], ['platform', 70, 200]]);
    assert.equal(d.projects[1].pct, 35);
    assert.equal(d.projects[1].email, 'ops@example.com');
    assert.deepEqual(d.days, [{ date: '2026-10-05', costUsd: 100 }]);
    assert.equal(d.connections.length, 4);
    assert.ok(d.connections.every((c) => c.lastSyncAt === NOW.toISOString() && c.lastError === null));
    assert.deepEqual(d.connections.find((c) => c.tool === 'copilot').org, 'acme');
  } finally { await t.close(); }
});

test('vendor keys and Slack webhooks are never sent back by any endpoint', async () => {
  const t = await setup({ claude: 500 });
  const keys = ['claude', 'openai', 'copilot', 'cursor'].map((tool) => fakeKey(`secret-${tool}`));
  const hook = fakeSlackHook(7);
  try {
    const responses = [];
    for (const [i, tool] of ['claude', 'openai', 'copilot', 'cursor'].entries()) {
      responses.push(await t.call('POST', '/api/connections', { tool, apiKey: keys[i], org: 'acme', project: 'p' }));
    }
    responses.push(await t.call('POST', '/api/budget', { project: 'p', monthlyUsd: 1, email: 'a@b.co', slackWebhookUrl: hook }));
    responses.push(await t.call('POST', '/api/sync'));
    responses.push(await t.call('GET', '/api/usage'));
    responses.push(await t.call('POST', '/api/connections', { tool: 'claude', apiKey: keys[0], project: 'other' }));
    const all = JSON.stringify(responses);
    for (const secret of [...keys, hook]) assert.equal(all.includes(secret), false);
    const usage = responses.at(-2).body;
    assert.equal(usage.projects.find((p) => p.name === 'p').hasSlack, true);
    assert.ok(usage.connections.every((c) => !('apiKey' in c)));
  } finally { await t.close(); }
});

test('connection validation: tool, key, Copilot org, project label, duplicates', async () => {
  const t = await setup();
  try {
    const post = (body) => t.call('POST', '/api/connections', body);
    assert.equal((await post({ tool: 'gemini', apiKey: 'k' })).status, 400);
    assert.equal((await post({ tool: 'toString', apiKey: 'k' })).status, 400);
    assert.equal((await post({ tool: 'openai' })).status, 400);
    assert.equal((await post({ tool: 'openai', apiKey: '   ' })).status, 400);
    assert.equal((await post({ tool: 'copilot', apiKey: 'k' })).status, 400);
    assert.equal((await post({ tool: 'copilot', apiKey: 'k', org: 'a/../b' })).status, 400);
    assert.equal((await post({ tool: 'openai', apiKey: 'k', project: '<script>' })).status, 400);
    assert.equal((await post({ tool: 'openai', apiKey: 'k', project: 'a|b' })).status, 400);
    assert.equal((await post({ tool: 'openai', apiKey: 'k', project: 'x'.repeat(65) })).status, 400);
    assert.equal((await post({ tool: 'openai', apiKey: 'k', project: 42 })).status, 400);
    const ok = await post({ tool: 'openai', apiKey: 'k', project: 'acme/web' });
    assert.equal(ok.status, 201);
    assert.equal(typeof ok.body.id, 'string');
    const dup = await post({ tool: 'openai', apiKey: ' k ', project: 'other' });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /acme\/web/);
    assert.equal((await post({ tool: 'claude', apiKey: 'k2' })).status, 201);
    const projects = (await t.call('GET', '/api/usage')).body.connections.map((c) => c.project);
    assert.deepEqual(projects, ['acme/web', 'default']);
  } finally { await t.close(); }
});

test('relabel a connection (PATCH) and its spend moves to the new project', async () => {
  const t = await setup({ openai: 25 });
  try {
    const { id } = (await t.call('POST', '/api/connections', { tool: 'openai', apiKey: 'k', project: 'old' })).body;
    await t.call('POST', '/api/sync');
    assert.equal((await t.call('PATCH', `/api/connections/${id}`, { project: 'bad|label' })).status, 400);
    assert.equal((await t.call('PATCH', '/api/connections/nope', { project: 'new' })).status, 404);
    assert.equal((await t.call('PATCH', `/api/connections/${id}`, { project: 'acme/new' })).status, 200);
    const d = (await t.call('GET', '/api/usage')).body;
    assert.deepEqual(d.projects.map((p) => [p.name, p.spend]), [['acme/new', 25]]);
  } finally { await t.close(); }
});

test('revoke: DELETE removes the stored key and its usage', async () => {
  const t = await setup({ cursor: 12 });
  try {
    const key = fakeKey('revoke-me');
    const { id } = (await t.call('POST', '/api/connections', { tool: 'cursor', apiKey: key, project: 'p' })).body;
    await t.call('POST', '/api/sync');
    assert.equal((await t.call('DELETE', `/api/connections/${id}`)).status, 200);
    assert.equal(JSON.stringify(t.store.get()).includes(key), false);
    assert.equal(t.store.get().usage[id], undefined);
    const d = (await t.call('GET', '/api/usage')).body;
    assert.deepEqual(d.connections, []);
    assert.equal(d.totalUsd, 0);
    assert.equal((await t.call('DELETE', `/api/connections/${id}`)).status, 404);
  } finally { await t.close(); }
});

test('budget per project: Slack webhook kept when omitted, removed with an empty string, rejected if not Slack', async () => {
  const t = await setup();
  try {
    const hook = fakeSlackHook();
    const save = (body) => t.call('POST', '/api/budget', { project: 'p', monthlyUsd: 50, email: 'a@b.co', ...body });
    assert.equal((await save({ slackWebhookUrl: 'https://example.com/hook' })).status, 400);
    assert.equal((await save({ slackWebhookUrl: 'http://127.0.0.1:3000/api/key' })).status, 400);
    assert.equal((await save({ project: 'bad|name' })).status, 400);
    assert.equal((await save({ monthlyUsd: 0 })).status, 400);
    assert.equal((await save({ monthlyUsd: '50' })).status, 400);
    assert.equal((await save({ slackWebhookUrl: hook })).status, 200);
    const hasSlack = async () => (await t.call('GET', '/api/usage')).body.projects.find((p) => p.name === 'p').hasSlack;
    assert.equal(await hasSlack(), true);
    assert.equal((await save({ monthlyUsd: 80 })).status, 200);
    assert.equal(await hasSlack(), true);
    assert.equal(t.store.get().projects.p.monthlyUsd, 80);
    assert.equal((await save({ slackWebhookUrl: '' })).status, 200);
    assert.equal(await hasSlack(), false);
  } finally { await t.close(); }
});

test('changing a budget re-arms that project\'s alerts but not other projects\'', async () => {
  const t = await setup({ claude: 120, openai: 120 });
  try {
    await t.call('POST', '/api/connections', { tool: 'claude', apiKey: 'k1', project: 'a' });
    await t.call('POST', '/api/connections', { tool: 'openai', apiKey: 'k2', project: 'b' });
    await t.call('POST', '/api/budget', { project: 'a', monthlyUsd: 100, email: 'a@b.co' });
    await t.call('POST', '/api/budget', { project: 'b', monthlyUsd: 100, email: 'b@b.co' });
    await t.call('POST', '/api/sync');
    assert.equal(t.mailer.sent.length, 2);
    await t.call('POST', '/api/budget', { project: 'a', monthlyUsd: 110, email: 'a@b.co' });
    await t.call('POST', '/api/sync');
    assert.deepEqual(t.mailer.sent.map((m) => m.to), ['a@b.co', 'b@b.co', 'a@b.co']);
  } finally { await t.close(); }
});

test('mutations need a JSON content type (blocks cross-site form/text posts) and a JSON object body', async () => {
  const t = await setup();
  try {
    const plain = await t.call('POST', '/api/budget', JSON.stringify({ monthlyUsd: 5, email: 'evil@example.com' }), { 'content-type': 'text/plain' });
    assert.equal(plain.status, 415);
    assert.equal((await t.call('POST', '/api/connections', 'tool=openai&apiKey=k', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await t.call('POST', '/api/sync', undefined, {})).status, 415);
    assert.equal(t.store.get().projects.default, undefined);
    assert.equal((await t.call('POST', '/api/connections', '{nope')).status, 400);
    assert.equal((await t.call('POST', '/api/connections', 'null')).status, 400);
    assert.equal((await t.call('POST', '/api/connections', '[1]')).status, 400);
    assert.equal((await t.call('GET', '/api/nothing')).status, 404);
    assert.equal((await t.call('PUT', '/api/budget', {})).status, 404);
  } finally { await t.close(); }
});

test('M1 /api/key replaces the default Claude key in place and refuses a key already used elsewhere', async () => {
  const t = await setup();
  try {
    assert.equal((await t.call('POST', '/api/key', { apiKey: fakeKey('one') })).status, 200);
    const id = t.store.get().connections[0].id;
    assert.equal((await t.call('POST', '/api/key', { apiKey: fakeKey('two') })).status, 200);
    assert.deepEqual(t.store.get().connections.map((c) => [c.id, c.apiKey]), [[id, fakeKey('two')]]);
    assert.equal((await t.call('POST', '/api/key', { apiKey: fakeKey('two') })).status, 200);
    await t.call('POST', '/api/connections', { tool: 'claude', apiKey: fakeKey('three'), project: 'other' });
    assert.equal((await t.call('POST', '/api/key', { apiKey: fakeKey('three') })).status, 409);
    assert.equal((await t.call('POST', '/api/key', {})).status, 400);
  } finally { await t.close(); }
});

test('an oversized request body is refused', async () => {
  const t = await setup();
  try {
    const r = await t.call('POST', '/api/connections', { tool: 'openai', apiKey: 'x'.repeat(100_000) });
    assert.equal(r.status, 413);
    assert.equal(t.store.get().connections.length, 0);
  } finally { await t.close(); }
});

test('the dashboard page offers every tool, project budgets with Slack, and a revoke button', async () => {
  const t = await setup();
  try {
    const page = await t.call('GET', '/');
    assert.equal(page.status, 200);
    for (const marker of ['id="chart"', 'id="connect"', 'id="projects"', 'id="connections"', 'name="slackWebhookUrl"', 'name="project"', 'Remove']) {
      assert.ok(page.body.includes(marker), marker);
    }
  } finally { await t.close(); }
});

test('an M1 data file (one Claude key, one budget) is migrated into the default project', async () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({
    apiKey: fakeKey('m1'),
    budget: { monthlyUsd: 70, email: 'lead@example.com' },
    days: { '2026-10-01': 50, '2026-10-02': 25 },
    alerted: { '2026-10': true },
  }));
  const store = createStore(file);
  const s = store.get();
  assert.equal(s.connections.length, 1);
  assert.deepEqual({ tool: s.connections[0].tool, project: s.connections[0].project, apiKey: s.connections[0].apiKey }, { tool: 'claude', project: 'default', apiKey: fakeKey('m1') });
  assert.deepEqual(store.days(), [{ date: '2026-10-01', costUsd: 50 }, { date: '2026-10-02', costUsd: 25 }]);
  assert.deepEqual(s.projects.default, { monthlyUsd: 70, email: 'lead@example.com', slackWebhookUrl: null });

  // The M1 100% email already went out this month: no repeat after the upgrade.
  const mailer = fakeMailer();
  const app = await startApp({ store, mailer, fetch: fakeVendors({ claude: 80 }), now: () => NOW });
  try {
    await app.call('POST', '/api/sync');
    assert.equal(mailer.sent.length, 0);
    const d = (await app.call('GET', '/api/usage')).body;
    assert.equal(d.hasKey, true);
    assert.deepEqual(d.budget, { monthlyUsd: 70, email: 'lead@example.com' });
    assert.equal(d.status.spend, 155);
  } finally { await app.close(); }
  // A second load reads the migrated (v2) file as-is.
  assert.equal(createStore(file).get().connections[0].id, s.connections[0].id);
});
