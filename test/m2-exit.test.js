// M2 exit criterion: when usage from any connected tool exceeds the project budget,
// an alert is sent via both email and Slack within 5 minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { DEFAULT_SYNC_INTERVAL_MS } from '../src/sync.js';
import { fakeVendors, fakeMailer, fakeKey, fakeSlackHook, startApp, tmpFile } from './helpers.js';

const FIVE_MIN = 5 * 60_000;
const NOW = new Date('2026-10-05T12:00:00Z');
const TOOLS = [['claude', {}], ['openai', {}], ['copilot', { org: 'acme' }], ['cursor', {}]];

test('default sync interval leaves the 5-minute alert promise with headroom', () => {
  assert.ok(DEFAULT_SYNC_INTERVAL_MS > 0 && DEFAULT_SYNC_INTERVAL_MS < FIVE_MIN);
});

for (const [tool, extra] of TOOLS) {
  test(`exit: ${tool} usage over the project budget alerts by email AND Slack within 5 minutes, no manual sync`, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const f = fakeVendors({ [tool]: 40 });
    const mailer = fakeMailer();
    const app = await startApp({ store: createStore(tmpFile()), mailer, fetch: f, now: () => NOW, syncIntervalMs: DEFAULT_SYNC_INTERVAL_MS });
    try {
      assert.equal((await app.call('POST', '/api/connections', { tool, apiKey: fakeKey(tool), project: 'acme/web', ...extra })).status, 201);
      const hook = fakeSlackHook();
      assert.equal((await app.call('POST', '/api/budget', { project: 'acme/web', monthlyUsd: 100, email: 'lead@example.com', slackWebhookUrl: hook })).status, 200);

      // First scheduled sync: $40 of $100, below every threshold.
      t.mock.timers.tick(DEFAULT_SYNC_INTERVAL_MS);
      await app.server.syncer.idle();
      assert.equal(mailer.sent.length, 0);
      assert.equal(f.slack.length, 0);

      // Usage jumps past the budget; within 5 minutes both channels fire on their own.
      f.usd[tool] = 120;
      t.mock.timers.tick(FIVE_MIN);
      await app.server.syncer.idle();

      assert.equal(mailer.sent.length, 1);
      assert.equal(mailer.sent[0].to, 'lead@example.com');
      assert.match(mailer.sent[0].subject, /acme\/web.*100%/);
      assert.equal(f.slack.length, 1);
      assert.equal(f.slack[0].url, hook);
      assert.match(f.slack[0].text, /acme\/web/);
      assert.match(f.slack[0].text, /100%/);
      assert.match(f.slack[0].text, /\$120\.00/);
    } finally { await app.close(); }
  });
}

test('exit over HTTP: "Sync now" on an over-budget project reports email and Slack delivery', async () => {
  const f = fakeVendors({ openai: 30, cursor: 80 });
  const mailer = fakeMailer();
  const app = await startApp({ store: createStore(tmpFile()), mailer, fetch: f, now: () => NOW });
  try {
    await app.call('POST', '/api/connections', { tool: 'openai', apiKey: fakeKey('o'), project: 'acme/web' });
    await app.call('POST', '/api/connections', { tool: 'cursor', apiKey: fakeKey('c'), project: 'acme/web' });
    await app.call('POST', '/api/budget', { project: 'acme/web', monthlyUsd: 100, email: 'lead@example.com', slackWebhookUrl: fakeSlackHook() });
    const sync = await app.call('POST', '/api/sync');
    assert.equal(sync.status, 200);
    assert.equal(sync.body.alerted, true);
    assert.deepEqual(sync.body.sent.map((s) => s.channel).sort(), ['email', 'slack']);
    assert.ok(sync.body.sent.every((s) => s.project === 'acme/web' && s.threshold === 100));
    assert.equal(mailer.sent.length, 1);
    assert.equal(f.slack.length, 1);
  } finally { await app.close(); }
});
