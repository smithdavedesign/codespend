import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { fakeVendors, fakeMailer, fakeKey, startApp, tmpFile } from './helpers.js';

const NOW = new Date('2026-10-05T12:00:00Z');

async function setup(opts = {}) {
  const store = createStore(tmpFile());
  const mailer = fakeMailer();
  const app = await startApp({ store, mailer, fetch: fakeVendors(), now: () => NOW, ...opts });
  return { ...app, store, mailer };
}

// Synced vendor usage, seeded straight into the store: {tool, project, usage: {date: usd}}.
function seed(store, conns) {
  store.update((s) => {
    conns.forEach((c, i) => {
      const id = `c${i}`;
      s.connections.push({ id, tool: c.tool, project: c.project, org: c.tool === 'copilot' ? 'acme' : null, apiKey: fakeKey(id), lastSyncAt: NOW.toISOString(), lastError: null });
      s.usage[id] = c.usage;
    });
  });
}

const report = (rows, extra = {}) => ({ project: 'acme/web', source: 'laptop1', rows, ...extra });
const row = (date, branch, costUsd, tokens = 1000, commits = 0) => ({ date, branch, costUsd, tokens, commits });

// ---------- branch reports ----------

test('POST /api/branches validates the report', async () => {
  const t = await setup();
  try {
    const post = (body) => t.call('POST', '/api/branches', body);
    assert.equal((await post({ project: 'p', source: 's' })).status, 400);
    assert.equal((await post({ project: 'p', source: 's', rows: 'x' })).status, 400);
    assert.equal((await post(report([row('2026-13-01', 'main', 1)]))).status, 400);
    assert.equal((await post(report([row('2026-02-30', 'main', 1)]))).status, 400);
    assert.equal((await post(report([row('2026-10-01', 'main', -1)]))).status, 400);
    assert.equal((await post(report([row('2026-10-01', 'main', Infinity)]))).status, 400);
    assert.equal((await post(report([row('2026-10-01', 'main', 1, 1.5)]))).status, 400);
    assert.equal((await post(report([row('2026-10-01', 'main', 1, 1, -1)]))).status, 400);
    assert.equal((await post(report([row('2026-10-01', '', 1)]))).status, 400);
    assert.equal((await post(report([row('2026-10-01', 'a\nb', 1)]))).status, 400);
    assert.equal((await post(report([row('2026-10-01', 'b'.repeat(256), 1)]))).status, 400);
    assert.equal((await post(report([{ date: '2026-10-01', branch: 'main', costUsd: '1', tokens: 0, commits: 0 }]))).status, 400);
    assert.equal((await post(report([row('2026-10-01', 'main', 1)], { source: 'bad source!' }))).status, 400);
    assert.equal((await post(report([row('2026-10-01', 'main', 1)], { source: '__proto__' }))).status, 400);
    assert.equal((await post(report([row('2026-10-01', 'main', 1)], { project: 'bad|label' }))).status, 400);
    assert.equal((await post(report([row('2026-10-01', 'main', 1)], { project: '__proto__' }))).status, 400);
    assert.equal((await post(report(Array.from({ length: 5001 }, (_, i) => row('2026-10-01', `b${i}`, 0))))).status, 400);
    assert.deepEqual(t.store.get().branches, {});
    const okRes = await post(report([row('2026-10-01', '=odd "branch", yes', 1)]));
    assert.equal(okRes.status, 200);
    assert.deepEqual(okRes.body, { ok: true, project: 'acme/web', rows: 1 });
    // A JSON content type is required, like every other mutation.
    assert.equal((await t.call('POST', '/api/branches', JSON.stringify(report([row('2026-10-01', 'x', 1)])), { 'content-type': 'text/plain' })).status, 415);
  } finally { await t.close(); }
});

test('a re-post from the same source replaces the days it covers; other days and other sources are kept and add up', async () => {
  const t = await setup();
  try {
    await t.call('POST', '/api/branches', report([row('2026-10-01', 'main', 1, 100, 1), row('2026-10-02', 'feat', 2, 200, 2)]));
    await t.call('POST', '/api/branches', report([row('2026-10-02', 'feat', 5, 500, 3), row('2026-10-02', 'feat', 1, 100, 0)]));
    await t.call('POST', '/api/branches', report([row('2026-10-02', 'feat', 10, 1000, 1)], { source: 'desktop2' }));
    const v = (await t.call('GET', '/api/branches?project=acme/web')).body;
    // feat: this laptop's re-post (5 + 1, its duplicate rows summed) plus the desktop's 10.
    assert.deepEqual(v.branches.map((b) => [b.branch, b.costUsd, b.tokens, b.commits]), [['feat', 16, 1600, 4], ['main', 1, 100, 1]]);
    assert.equal(v.totalUsd, 17);
    assert.equal(v.tokens, 1700);
    assert.equal(v.commits, 5);
    assert.deepEqual(v.branches[0].days, [{ date: '2026-10-02', costUsd: 16 }]);
  } finally { await t.close(); }
});

test('GET /api/branches: project choice, date range, empty projects and bad ranges', async () => {
  const t = await setup();
  try {
    const empty = (await t.call('GET', '/api/branches')).body;
    assert.deepEqual({ project: empty.project, projects: empty.projects, branches: empty.branches, totalUsd: empty.totalUsd }, { project: null, projects: [], branches: [], totalUsd: 0 });
    assert.deepEqual([empty.from, empty.to], ['2026-10-01', '2026-10-31']);

    await t.call('POST', '/api/branches', report([row('2026-09-30', 'old', 4), row('2026-10-03', 'new', 1)], { project: 'zeta' }));
    await t.call('POST', '/api/branches', report([row('2026-10-03', 'main', 3)], { project: 'alpha' }));
    const first = (await t.call('GET', '/api/branches')).body;
    assert.equal(first.project, 'alpha');
    assert.deepEqual(first.projects, ['alpha', 'zeta']);

    // Default range is this month: September's branch is outside it.
    assert.deepEqual((await t.call('GET', '/api/branches?project=zeta')).body.branches.map((b) => b.branch), ['new']);
    const wide = (await t.call('GET', '/api/branches?project=zeta&from=2026-09-01&to=2026-10-31')).body;
    assert.deepEqual(wide.branches.map((b) => [b.branch, b.sharePct]), [['old', 80], ['new', 20]]);
    assert.deepEqual((await t.call('GET', '/api/branches?project=nobody')).body.branches, []);
    assert.equal((await t.call('GET', '/api/branches?from=2026-10-09&to=2026-10-01')).status, 400);
    assert.equal((await t.call('GET', '/api/branches?project=bad|label')).status, 400);
  } finally { await t.close(); }
});

test('DELETE /api/branches?project= removes that project\'s branch data only', async () => {
  const t = await setup();
  try {
    await t.call('POST', '/api/branches', report([row('2026-10-03', 'main', 3)], { project: 'a' }));
    await t.call('POST', '/api/branches', report([row('2026-10-03', 'main', 3)], { project: 'b' }));
    assert.equal((await t.call('DELETE', '/api/branches?project=a')).status, 200);
    assert.deepEqual(Object.keys(t.store.get().branches), ['b']);
    assert.equal((await t.call('DELETE', '/api/branches?project=a')).status, 404);
    assert.equal((await t.call('DELETE', '/api/branches')).status, 400);
  } finally { await t.close(); }
});

// ---------- date range on the dashboard ----------

test('dashboard date range: defaults to this month; a custom range drives tool totals and charts; budgets stay month-to-date', async () => {
  const t = await setup();
  try {
    seed(t.store, [
      { tool: 'claude', project: 'acme/web', usage: { '2026-09-28': 50, '2026-10-01': 10, '2026-10-05': 5 } },
      { tool: 'cursor', project: 'acme/web', usage: { '2026-09-29': 7, '2026-10-02': 3 } },
    ]);
    await t.call('POST', '/api/budget', { project: 'acme/web', monthlyUsd: 100, email: 'a@b.co' });

    const d = (await t.call('GET', '/api/usage')).body;
    assert.deepEqual(d.range, { from: '2026-10-01', to: '2026-10-31', totalUsd: 18 });
    assert.equal(d.totalUsd, 18);
    const claude = d.tools.find((x) => x.tool === 'claude');
    assert.deepEqual([claude.monthUsd, claude.rangeUsd], [15, 15]);
    assert.deepEqual(claude.days.map((x) => x.date), ['2026-10-01', '2026-10-05']);

    const r = (await t.call('GET', '/api/usage?from=2026-09-28&to=2026-10-01')).body;
    assert.deepEqual(r.range, { from: '2026-09-28', to: '2026-10-01', totalUsd: 67 });
    const c2 = r.tools.find((x) => x.tool === 'claude');
    assert.deepEqual([c2.monthUsd, c2.rangeUsd], [15, 60]);
    assert.deepEqual(c2.days, [{ date: '2026-09-28', costUsd: 50 }, { date: '2026-10-01', costUsd: 10 }]);
    assert.deepEqual(r.tools.find((x) => x.tool === 'cursor').days, [{ date: '2026-09-29', costUsd: 7 }]);
    // The budget table is about this month whatever the range.
    assert.deepEqual(r.projects.map((p) => [p.name, p.spend, p.pct]), [['acme/web', 18, 18]]);
    assert.equal(r.totalUsd, 18);
  } finally { await t.close(); }
});

test('dashboard date range: invalid input is a 400', async () => {
  const t = await setup();
  try {
    for (const q of ['from=2026-10-09&to=2026-10-01', 'from=2026-02-30', 'to=yesterday', 'from=2024-01-01&to=2026-10-01', 'from=2026-1-1']) {
      const r = await t.call('GET', `/api/usage?${q}`);
      assert.equal(r.status, 400, q);
      assert.match(r.body.error, /from|to|range/);
    }
    // One side alone is fine: the other keeps its default.
    assert.deepEqual((await t.call('GET', '/api/usage?from=2026-09-15')).body.range.to, '2026-10-31');
  } finally { await t.close(); }
});

// ---------- CSV export ----------

test('usage CSV: one row per day, tool and project in the range, as a download', async () => {
  const t = await setup();
  try {
    seed(t.store, [
      { tool: 'claude', project: 'acme/web', usage: { '2026-09-28': 50, '2026-10-01': 10.123456789 } },
      { tool: 'claude', project: 'acme/web', usage: { '2026-10-01': 1 } },
      { tool: 'copilot', project: '-platform', usage: { '2026-10-02': 3 } },
    ]);
    const r = await fetch(`http://127.0.0.1:${t.server.address().port}/api/usage.csv`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/csv/);
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="codespend-usage-2026-10-01-to-2026-10-31.csv"');
    // Two Claude connections in one project are summed; a cell starting with "-" can't run as a formula.
    assert.equal(await r.text(), 'date,tool,project,cost_usd\r\n2026-10-01,claude,acme/web,11.123457\r\n2026-10-02,copilot,\'-platform,3\r\n');
    const wide = await t.call('GET', '/api/usage.csv?from=2026-09-01&to=2026-09-30');
    assert.equal(wide.body, 'date,tool,project,cost_usd\r\n2026-09-28,claude,acme/web,50\r\n');
    assert.equal((await t.call('GET', '/api/usage.csv?from=nope')).status, 400);
  } finally { await t.close(); }
});

test('branch CSV: per day and branch, sources summed, formulas and quotes neutralised, one project or all', async () => {
  const t = await setup();
  try {
    await t.call('POST', '/api/branches', report([row('2026-10-01', '=HYPERLINK("http://x")', 1.5, 10, 1), row('2026-10-02', 'feat,"q"', 2, 20, 0)]));
    await t.call('POST', '/api/branches', report([row('2026-10-01', '=HYPERLINK("http://x")', 0.5, 5, 1)], { source: 'other' }));
    await t.call('POST', '/api/branches', report([row('2026-10-03', '@sum', 1, 1, 0)], { project: 'zeta' }));
    const one = await fetch(`http://127.0.0.1:${t.server.address().port}/api/branches.csv?project=acme/web`);
    assert.match(one.headers.get('content-type'), /^text\/csv/);
    assert.equal(one.headers.get('content-disposition'), 'attachment; filename="codespend-branches-2026-10-01-to-2026-10-31.csv"');
    assert.equal(await one.text(), [
      'date,project,branch,cost_usd,tokens,commits',
      '2026-10-01,acme/web,"\'=HYPERLINK(""http://x"")",2,15,2',
      '2026-10-02,acme/web,"feat,""q""",2,20,0',
      '',
    ].join('\r\n'));
    const all = (await t.call('GET', '/api/branches.csv')).body.split('\r\n');
    assert.equal(all.length, 5);
    assert.equal(all[3], "2026-10-03,zeta,'@sum,1,1,0");
  } finally { await t.close(); }
});

// ---------- onboarding, billing, legal ----------

test('onboarding flags flip as each step is done: connect, budget, first sync, branches', async () => {
  const t = await setup({ fetch: fakeVendors({ openai: 5 }) });
  try {
    const flags = async () => (await t.call('GET', '/api/usage')).body.onboarding;
    assert.deepEqual(await flags(), { connected: false, budgeted: false, synced: false, branches: false });
    await t.call('POST', '/api/connections', { tool: 'openai', apiKey: fakeKey('o'), project: 'acme/web' });
    assert.deepEqual(await flags(), { connected: true, budgeted: false, synced: false, branches: false });
    await t.call('POST', '/api/budget', { project: 'acme/web', monthlyUsd: 100, email: 'a@b.co' });
    await t.call('POST', '/api/sync');
    assert.deepEqual(await flags(), { connected: true, budgeted: true, synced: true, branches: false });
    await t.call('POST', '/api/branches', report([row('2026-10-01', 'main', 1)]));
    assert.deepEqual(await flags(), { connected: true, budgeted: true, synced: true, branches: true });
  } finally { await t.close(); }
});

test('billing links: valid Stripe payment and portal links are offered; anything else is dropped', async () => {
  const pay = ['https://buy.stripe.com', 'test_' + 'a1B2c3'.repeat(3)].join('/');
  const portal = ['https://billing.stripe.com/p/login', 'test_' + 'z9Y8'.repeat(4)].join('/');
  const good = await setup({ billing: { paymentLink: pay, portalLink: portal } });
  try {
    assert.deepEqual((await good.call('GET', '/api/usage')).body.billing, { priceUsd: 9, paymentLink: pay, portalLink: portal });
  } finally { await good.close(); }
  for (const bad of ['http://buy.stripe.com/x', 'https://buy.stripe.com.evil.example/x', 'https://evil.example/buy.stripe.com', 'https://u:p@buy.stripe.com/x', 'https://buy.stripe.com/', 'javascript:alert(1)']) {
    const t = await setup({ billing: { paymentLink: bad, portalLink: bad.replace('buy.', 'billing.') } });
    try {
      assert.deepEqual((await t.call('GET', '/api/usage')).body.billing, { priceUsd: 9, paymentLink: null, portalLink: null }, bad);
    } finally { await t.close(); }
  }
});

test('privacy policy and terms are served, say what is stored and how to delete it, with the contact address escaped', async () => {
  const t = await setup({ contactEmail: 'owner+legal@example.com' });
  try {
    for (const path of ['/privacy', '/terms']) {
      const page = await t.call('GET', path);
      assert.equal(page.status, 200, path);
      assert.match(page.body, /<title>/);
      assert.match(page.body, /mailto:owner\+legal@example\.com/);
    }
    const privacy = (await t.call('GET', '/privacy')).body;
    for (const words of [/encrypted/i, /AES-256-GCM/, /Remove/, /delet/i, /never (sent|shown)/i, /branch/i, /Stripe/]) assert.match(privacy, words);
    assert.match((await t.call('GET', '/terms')).body, /\$9/);
  } finally { await t.close(); }
  // "$&" in an address is inserted literally (a string replacement would expand it).
  const dollar = await setup({ contactEmail: 'pay$&me@example.com' });
  try {
    assert.match((await dollar.call('GET', '/terms')).body, /mailto:pay\$&#38;me@example\.com/);
  } finally { await dollar.close(); }
  const noContact = await setup({ contactEmail: '"><script>alert(1)</script>' });
  try {
    const page = (await noContact.call('GET', '/privacy')).body;
    assert.equal(page.includes('<script>alert'), false);
    assert.match(page, /the person who runs this CodeSpend server/);
  } finally { await noContact.close(); }
});

test('the page has the range picker, CSV links, per-tool charts, branch view, onboarding, pricing and legal links', async () => {
  const t = await setup();
  try {
    const page = (await t.call('GET', '/')).body;
    for (const marker of ['id="range-from"', 'id="range-to"', 'id="usage-csv"', 'id="tool-charts"', 'id="branches"', 'id="branches-csv"', 'id="branch-project"',
      'id="onboarding"', 'codespend-branches', 'id="pricing"', 'href="/privacy"', 'href="/terms"',
      // Buttons and links styled with `display` must still disappear when hidden (Upgrade without a link, Delete without data).
      '[hidden]{display:none !important}']) {
      assert.ok(page.includes(marker), marker);
    }
  } finally { await t.close(); }
});
