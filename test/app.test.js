import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';
import { fakeFetch, fakeMailer } from './helpers.js';

async function setup() {
  const store = createStore(join(mkdtempSync(join(tmpdir(), 'cs-')), 'db.json'));
  const mailer = fakeMailer();
  const app = createApp({ store, mailer, fetch: fakeFetch(), now: () => new Date('2026-10-05T12:00:00Z') });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() };
  };
  return { call, mailer, store, close: () => server.close() };
}

test('add key + budget, sync logs usage, alert sent when threshold crossed (exit criterion)', async () => {
  const t = await setup();
  try {
    assert.equal((await t.call('POST', '/api/key', { apiKey: 'sk-ant-admin-test' })).status, 200);
    assert.equal((await t.call('POST', '/api/budget', { monthlyUsd: 70, email: 'lead@example.com' })).status, 200);
    const sync = await t.call('POST', '/api/sync');
    assert.equal(sync.status, 200);
    assert.equal(sync.body.alerted, true);

    const usage = await t.call('GET', '/api/usage');
    assert.deepEqual(usage.body.days, [{ date: '2026-10-01', costUsd: 50 }, { date: '2026-10-02', costUsd: 25 }]);
    assert.equal(usage.body.status.spend, 75);
    assert.equal(usage.body.status.crossed, true);

    assert.equal(t.mailer.sent.length, 1);
    assert.equal(t.mailer.sent[0].to, 'lead@example.com');
    assert.match(t.mailer.sent[0].subject, /100%/);
  } finally { t.close(); }
});

test('no alert when under budget', async () => {
  const t = await setup();
  try {
    await t.call('POST', '/api/key', { apiKey: 'k' });
    await t.call('POST', '/api/budget', { monthlyUsd: 500, email: 'a@b.co' });
    const sync = await t.call('POST', '/api/sync');
    assert.equal(sync.body.alerted, false);
    assert.equal(t.mailer.sent.length, 0);
  } finally { t.close(); }
});

test('repeated syncs alert only once per month', async () => {
  const t = await setup();
  try {
    await t.call('POST', '/api/key', { apiKey: 'k' });
    await t.call('POST', '/api/budget', { monthlyUsd: 10, email: 'a@b.co' });
    await t.call('POST', '/api/sync');
    await t.call('POST', '/api/sync');
    assert.equal(t.mailer.sent.length, 1);
  } finally { t.close(); }
});

test('re-syncing does not double count usage', async () => {
  const t = await setup();
  try {
    await t.call('POST', '/api/key', { apiKey: 'k' });
    await t.call('POST', '/api/sync');
    await t.call('POST', '/api/sync');
    assert.equal((await t.call('GET', '/api/usage')).body.status.spend, 75);
  } finally { t.close(); }
});

test('API key is never returned by the API', async () => {
  const t = await setup();
  try {
    await t.call('POST', '/api/key', { apiKey: 'sk-ant-secret' });
    const usage = await t.call('GET', '/api/usage');
    assert.equal(JSON.stringify(usage.body).includes('sk-ant-secret'), false);
    assert.equal(usage.body.hasKey, true);
  } finally { t.close(); }
});

test('validation: bad budget and sync without key', async () => {
  const t = await setup();
  try {
    assert.equal((await t.call('POST', '/api/budget', { monthlyUsd: -1, email: 'a@b.co' })).status, 400);
    assert.equal((await t.call('POST', '/api/budget', { monthlyUsd: 5, email: 'nope' })).status, 400);
    assert.equal((await t.call('POST', '/api/sync')).status, 400);
  } finally { t.close(); }
});

test('frontend page with daily usage chart is served', async () => {
  const t = await setup();
  try {
    const page = await t.call('GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /<svg|id="chart"/);
  } finally { t.close(); }
});
