import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, fetchOpenAIUsage, fetchCopilotUsage, fetchCursorUsage } from '../src/providers.js';
import { fetchClaudeUsage } from '../src/claude.js';
import { fakeKey } from './helpers.js';

// A fetch that answers each call with the next canned body and records what was asked.
function scripted(...bodies) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url: new URL(String(url)), opts });
    const b = bodies[Math.min(calls.length, bodies.length) - 1];
    return typeof b === 'number' ? { ok: false, status: b, json: async () => ({}) } : { ok: true, status: 200, json: async () => b };
  };
  f.calls = calls;
  return f;
}
const unix = (date) => Date.parse(`${date}T00:00:00Z`) / 1000;

test('registry: Claude, OpenAI, Copilot and Cursor, and only Copilot needs an org', () => {
  assert.deepEqual(Object.keys(PROVIDERS), ['claude', 'openai', 'copilot', 'cursor']);
  for (const p of Object.values(PROVIDERS)) {
    assert.equal(typeof p.fetchUsage, 'function');
    assert.equal(typeof p.label, 'string');
  }
  assert.equal(PROVIDERS.claude.fetchUsage, fetchClaudeUsage);
  assert.deepEqual(Object.entries(PROVIDERS).filter(([, p]) => p.needsOrg).map(([k]) => k), ['copilot']);
});

test('OpenAI: daily cost buckets in USD, admin key as Bearer, window and page size in the query', async () => {
  const f = scripted({
    data: [
      { start_time: unix('2026-10-01'), end_time: unix('2026-10-02'), results: [{ amount: { value: 1.25, currency: 'usd' } }, { amount: { value: 0.75, currency: 'usd' } }] },
      { start_time: unix('2026-10-02'), end_time: unix('2026-10-03'), results: [] },
    ],
    has_more: false,
    next_page: null,
  });
  const key = fakeKey('openai');
  const days = await fetchOpenAIUsage({ apiKey: key, fetch: f, start: '2026-10-01', end: '2026-10-06' });
  assert.deepEqual(days, [{ date: '2026-10-01', costUsd: 2 }, { date: '2026-10-02', costUsd: 0 }]);
  const { url, opts } = f.calls[0];
  assert.equal(url.origin + url.pathname, 'https://api.openai.com/v1/organization/costs');
  assert.equal(url.searchParams.get('start_time'), String(unix('2026-10-01')));
  assert.equal(url.searchParams.get('end_time'), String(unix('2026-10-06')));
  assert.equal(url.searchParams.get('bucket_width'), '1d');
  assert.equal(url.searchParams.get('limit'), '31');
  assert.equal(opts.headers.authorization, `Bearer ${key}`);
});

test('OpenAI: follows next_page until has_more is false', async () => {
  const f = scripted(
    { data: [{ start_time: unix('2026-10-01'), results: [{ amount: { value: 3 } }] }], has_more: true, next_page: 'page_2' },
    { data: [{ start_time: unix('2026-10-01'), results: [{ amount: { value: 4 } }] }, { start_time: unix('2026-10-02'), results: [{ amount: { value: 1 } }] }], has_more: false },
  );
  const days = await fetchOpenAIUsage({ apiKey: 'k', fetch: f, start: '2026-10-01', end: '2026-10-03' });
  assert.deepEqual(days, [{ date: '2026-10-01', costUsd: 7 }, { date: '2026-10-02', costUsd: 1 }]);
  assert.equal(f.calls[1].url.searchParams.get('page'), 'page_2');
});

test('OpenAI: a rejected key is a clear error with the status', async () => {
  await assert.rejects(fetchOpenAIUsage({ apiKey: 'bad', fetch: scripted(401), start: '2026-10-01', end: '2026-10-02' }), /OpenAI API error: 401/);
});

test('Copilot: GitHub billing usage for the org, Copilot items only, net amount in USD, inside the window', async () => {
  const f = scripted({
    usageItems: [
      { date: '2026-10-01T00:00:00Z', product: 'Copilot', sku: 'Copilot Business', netAmount: 12.5, grossAmount: 12.5 },
      { date: '2026-10-01', product: 'copilot', sku: 'Copilot Premium Request', netAmount: 2.5, grossAmount: 4 },
      { date: '2026-10-02', product: 'Actions', sku: 'Actions Linux', netAmount: 99 },
      { date: '2026-10-07', product: 'Copilot', sku: 'Copilot Premium Request', netAmount: 50 },
    ],
  });
  const key = fakeKey('gh');
  const days = await fetchCopilotUsage({ apiKey: key, org: 'acme', fetch: f, start: '2026-10-01', end: '2026-10-06' });
  assert.deepEqual(days, [{ date: '2026-10-01', costUsd: 15 }]);
  const { url, opts } = f.calls[0];
  assert.equal(url.origin + url.pathname, 'https://api.github.com/organizations/acme/settings/billing/usage');
  assert.equal(url.searchParams.get('year'), '2026');
  assert.equal(url.searchParams.get('month'), '10');
  assert.equal(opts.headers.authorization, `Bearer ${key}`);
  assert.equal(opts.headers['x-github-api-version'], '2022-11-28');
  assert.ok(opts.headers['user-agent']);
});

test('Copilot: a window that spans two months asks for both', async () => {
  const f = scripted({ usageItems: [{ date: '2026-09-30', product: 'Copilot', netAmount: 1 }] }, { usageItems: [{ date: '2026-10-01', product: 'Copilot', netAmount: 2 }] });
  const days = await fetchCopilotUsage({ apiKey: 'k', org: 'acme', fetch: f, start: '2026-09-30', end: '2026-10-02' });
  assert.deepEqual(days, [{ date: '2026-09-30', costUsd: 1 }, { date: '2026-10-01', costUsd: 2 }]);
  assert.deepEqual(f.calls.map((c) => c.url.searchParams.get('month')), ['9', '10']);
});

test('Copilot: the org is URL-encoded and errors carry the status', async () => {
  const f = scripted(404);
  await assert.rejects(fetchCopilotUsage({ apiKey: 'k', org: 'a/../b', fetch: f, start: '2026-10-01', end: '2026-10-02' }), /GitHub API error: 404/);
  assert.equal(f.calls[0].url.pathname, '/organizations/a%2F..%2Fb/settings/billing/usage');
});

test('Cursor: usage events by UTC day, token cost in cents, Basic auth with the admin key', async () => {
  const at = (iso) => String(Date.parse(iso));
  const f = scripted({
    usageEvents: [
      { timestamp: at('2026-10-01T10:00:00Z'), kind: 'Usage-based', isTokenBasedCall: true, tokenUsage: { totalCents: 150 }, requestsCosts: 5 },
      { timestamp: at('2026-10-01T23:59:00Z'), kind: 'Included in Business', isTokenBasedCall: true, tokenUsage: { totalCents: 50 } },
      { timestamp: at('2026-10-02T08:00:00Z'), kind: 'Usage-based', isTokenBasedCall: false, requestsCosts: 10 },
      { timestamp: at('2026-10-02T09:00:00Z'), kind: 'Errored, Not Charged', isTokenBasedCall: true, tokenUsage: { totalCents: 999 } },
      { timestamp: at('2026-10-02T09:30:00Z'), kind: 'Usage-based', isFreeBugbot: true, tokenUsage: { totalCents: 999 } },
      { timestamp: 'not-a-time', kind: 'Usage-based', tokenUsage: { totalCents: 999 } },
    ],
    pagination: { hasNextPage: false },
  });
  const key = fakeKey('cursor');
  const days = await fetchCursorUsage({ apiKey: key, fetch: f, start: '2026-10-01', end: '2026-10-06' });
  assert.deepEqual(days, [{ date: '2026-10-01', costUsd: 2 }, { date: '2026-10-02', costUsd: 0.4 }]);
  const { url, opts } = f.calls[0];
  assert.equal(url.href, 'https://api.cursor.com/teams/filtered-usage-events');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers.authorization, `Basic ${Buffer.from(`${key}:`).toString('base64')}`);
  const body = JSON.parse(opts.body);
  assert.equal(body.startDate, Date.parse('2026-10-01T00:00:00Z'));
  assert.equal(body.endDate, Date.parse('2026-10-06T00:00:00Z') - 1);
  assert.equal(body.page, 1);
});

test('Cursor: follows pages until hasNextPage is false', async () => {
  const ev = (cents) => ({ timestamp: String(Date.parse('2026-10-03T12:00:00Z')), kind: 'Usage-based', tokenUsage: { totalCents: cents } });
  const f = scripted({ usageEvents: [ev(100)], pagination: { hasNextPage: true } }, { usageEvents: [ev(200)], pagination: { hasNextPage: false } });
  const days = await fetchCursorUsage({ apiKey: 'k', fetch: f, start: '2026-10-01', end: '2026-10-06' });
  assert.deepEqual(days, [{ date: '2026-10-03', costUsd: 3 }]);
  assert.deepEqual(f.calls.map((c) => JSON.parse(c.opts.body).page), [1, 2]);
});

test('Cursor: a runaway pager fails loudly instead of silently undercounting', async () => {
  const f = scripted({ usageEvents: [], pagination: { hasNextPage: true } });
  await assert.rejects(fetchCursorUsage({ apiKey: 'k', fetch: f, start: '2026-10-01', end: '2026-10-06' }), /too many pages/);
});

test('Cursor: a rejected key is a clear error with the status', async () => {
  await assert.rejects(fetchCursorUsage({ apiKey: 'bad', fetch: scripted(401), start: '2026-10-01', end: '2026-10-02' }), /Cursor API error: 401/);
});
