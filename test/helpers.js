import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';

// Fake Anthropic cost_report: two days of known usage (amounts in cents, as strings).
export const KNOWN = {
  data: [
    { starting_at: '2026-10-01T00:00:00Z', results: [{ amount: '4000.00', currency: 'USD' }, { amount: '1000.00', currency: 'USD' }] },
    { starting_at: '2026-10-02T00:00:00Z', results: [{ amount: '2500.00', currency: 'USD' }] },
  ],
  has_more: false,
};
export function fakeFetch(body = KNOWN, status = 200) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return { ok: status < 400, status, json: async () => body };
  };
  f.calls = calls;
  return f;
}
export function fakeMailer() {
  const sent = [];
  const m = { sent, fail: false, send: async (msg) => { if (m.fail) throw new Error('smtp down'); sent.push(msg); } };
  return m;
}

// M2: fake vendor APIs. Each tool reports f.usd[tool] dollars on f.date, honouring the requested window the way
// the real APIs do, so a window that misses today shows up as missing spend. Slack webhook posts are captured in f.slack.
// Mutate f.usd / f.date / f.fail to simulate usage growing, a new month, or an outage.
const HOSTS = { 'api.anthropic.com': 'claude', 'api.openai.com': 'openai', 'api.github.com': 'copilot', 'api.cursor.com': 'cursor', 'hooks.slack.com': 'slack' };

export function fakeVendors(usd = {}, { date = '2026-10-05', fail = {} } = {}) {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const f = async (input, opts = {}) => {
    const url = new URL(String(input));
    const tool = HOSTS[url.hostname];
    f.calls.push({ tool, url: url.href, opts });
    if (f.fail[tool]) return { ok: false, status: f.fail[tool], json: async () => ({}) };
    if (tool === 'slack') { f.slack.push({ url: url.href, ...JSON.parse(opts.body) }); return ok({}); }
    const v = f.usd[tool] ?? 0;
    const day = Date.parse(`${f.date}T00:00:00Z`);
    const q = (k) => url.searchParams.get(k);
    if (tool === 'claude') {
      const hit = v && day >= Date.parse(q('starting_at')) && day < Date.parse(q('ending_at'));
      return ok({ data: hit ? [{ starting_at: `${f.date}T00:00:00Z`, results: [{ amount: String(v * 100), currency: 'USD' }] }] : [], has_more: false });
    }
    if (tool === 'openai') {
      const s = day / 1000;
      const hit = s >= Number(q('start_time')) && s < Number(q('end_time'));
      return ok({
        object: 'page',
        data: hit ? [{ object: 'bucket', start_time: s, end_time: s + 86400, results: [{ object: 'organization.costs.result', amount: { value: v, currency: 'usd' }, line_item: null, project_id: null }] }] : [],
        has_more: false,
        next_page: null,
      });
    }
    if (tool === 'copilot') {
      const hit = `${q('year')}-${String(q('month')).padStart(2, '0')}` === f.date.slice(0, 7);
      return ok({
        usageItems: hit ? [
          { date: f.date, product: 'Copilot', sku: 'Copilot Premium Request', quantity: v / 0.04, unitType: 'requests', pricePerUnit: 0.04, grossAmount: v, discountAmount: 0, netAmount: v, organizationName: 'acme', repositoryName: '' },
          { date: f.date, product: 'Actions', sku: 'Actions Linux', quantity: 1000, unitType: 'minutes', pricePerUnit: 0.008, grossAmount: 8, discountAmount: 0, netAmount: 8, organizationName: 'acme', repositoryName: 'acme/web' },
        ] : [],
      });
    }
    if (tool === 'cursor') {
      const body = JSON.parse(opts.body);
      const ts = day + 3_600_000;
      const hit = v && ts >= body.startDate && ts <= body.endDate;
      return ok({
        totalUsageEventsCount: hit ? 1 : 0,
        pagination: { numPages: 1, currentPage: body.page, pageSize: body.pageSize, hasNextPage: false, hasPreviousPage: false },
        usageEvents: hit ? [{ timestamp: String(ts), model: 'claude-4-sonnet', kind: 'Usage-based', maxMode: false, requestsCosts: 1, isTokenBasedCall: true, tokenUsage: { inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, totalCents: v * 100 }, isFreeBugbot: false, userEmail: 'dev@example.com' }] : [],
      });
    }
    throw new Error(`unexpected fetch ${url.href}`);
  };
  Object.assign(f, { calls: [], slack: [], usd, date, fail });
  return f;
}

export const tmpFile = (name = 'db.json') => join(mkdtempSync(join(tmpdir(), 'cs-')), name);

// Start the real HTTP app on a random port; `call` speaks JSON like the page does.
export async function startApp(opts) {
  const server = createApp(opts);
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = { 'content-type': 'application/json' }) => {
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() };
  };
  return { server, call, close: () => new Promise((r) => server.close(r)) };
}

// Fake secrets are built at runtime so nothing credential-shaped is committed.
export const fakeKey = (name) => ['test', name, 'A1b2C3d4'.repeat(2)].join('-');
export const fakeSlackHook = (n = 1) => ['https://hooks.slack.com/services', `TFAKE${n}`, `BFAKE${n}`, 'x'.repeat(8)].join('/');
