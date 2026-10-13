// npm run screenshots: start CodeSpend and the public site, drive them with Playwright, save PNGs to docs/screenshots/,
// stop both.
//
// The dashboard runs in-process with a temporary data file. The vendor APIs (Anthropic, OpenAI, GitHub, Cursor) and the
// Slack webhook are stubbed with sample data, so no real key is used and nothing leaves the machine. The public site is
// built with the same code as `npm run build` into a temporary folder and served locally. Both get a placeholder
// payment link so the Get Pro buttons show. The browser may only reach 127.0.0.1.
// Chromium is never downloaded: set CHROMIUM_PATH to an installed Chromium/Chrome.
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright-core';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';
import { createMailer } from '../src/mailer.js';
import { buildSite } from '../src/site.js';
import { tmpDir } from '../test/repo-fixture.js';

const OUT = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
const PICTURE = fileURLToPath(new URL('../public/dashboard.png', import.meta.url));
const DAY = 86_400_000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

// Sample secrets and a placeholder payment link, built at runtime (nothing real, nothing credential-shaped in the repo).
const sampleKey = (tool) => ['sample', tool, 'A1b2C3d4'.repeat(3)].join('-');
const sampleHook = ['https://hooks.slack.com/services', 'TSAMPLE', 'BSAMPLE', 'x'.repeat(12)].join('/');
const PLACEHOLDER_PAYMENT_LINK = ['https://buy.stripe.com', 'placeholder'].join('/');

// Deterministic "random" daily spend per tool, lower at weekends.
const BASE_USD = { claude: 26, openai: 9, copilot: 11, cursor: 15 };
function dailyUsd(tool, date) {
  let h = 2166136261;
  for (const c of `${tool}${date}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const frac = (h >>> 0) / 2 ** 32;
  const weekend = [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
  return Math.round(BASE_USD[tool] * (0.55 + frac) * (weekend ? 0.35 : 1) * 100) / 100;
}

// Fake vendor APIs that honour each request's window, like the real ones (see test/helpers.js for the shapes).
function sampleVendors(now) {
  const today = iso(now);
  const first = `${today.slice(0, 8)}01`;
  const days = [];
  for (let t = Date.parse(first); iso(t) <= today; t += DAY) days.push(iso(t));
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  return async (input, opts = {}) => {
    const url = new URL(String(input));
    const q = (k) => url.searchParams.get(k);
    if (url.hostname === 'hooks.slack.com') return ok({});
    if (url.hostname === 'api.anthropic.com') {
      const inWin = days.filter((d) => d >= q('starting_at').slice(0, 10) && d < q('ending_at').slice(0, 10));
      return ok({ data: inWin.map((d) => ({ starting_at: `${d}T00:00:00Z`, results: [{ amount: String(dailyUsd('claude', d) * 100), currency: 'USD' }] })), has_more: false });
    }
    if (url.hostname === 'api.openai.com') {
      const inWin = days.filter((d) => Date.parse(d) / 1000 >= Number(q('start_time')) && Date.parse(d) / 1000 < Number(q('end_time')));
      return ok({ data: inWin.map((d) => ({ start_time: Date.parse(d) / 1000, results: [{ amount: { value: dailyUsd('openai', d), currency: 'usd' } }] })), has_more: false });
    }
    if (url.hostname === 'api.github.com') {
      const month = `${q('year')}-${String(q('month')).padStart(2, '0')}`;
      return ok({ usageItems: days.filter((d) => d.startsWith(month)).map((d) => ({ date: d, product: 'Copilot', sku: 'Copilot Premium Request', netAmount: dailyUsd('copilot', d) })) });
    }
    if (url.hostname === 'api.cursor.com') {
      const body = JSON.parse(opts.body);
      const inWin = days.filter((d) => Date.parse(d) + 3_600_000 >= body.startDate && Date.parse(d) + 3_600_000 <= body.endDate);
      return ok({
        pagination: { hasNextPage: false },
        usageEvents: inWin.map((d) => ({ timestamp: String(Date.parse(d) + 3_600_000), kind: 'Usage-based', tokenUsage: { totalCents: Math.round(dailyUsd('cursor', d) * 100) } })),
      });
    }
    throw new Error(`unexpected request to ${url.hostname}`);
  };
}

// The built site, served the way Vercel serves it (cleanUrls: /privacy answers with privacy.html).
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.txt': 'text/plain', '.xml': 'application/xml' };
function staticSite(dir) {
  return createServer((req, res) => {
    let path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/') path = '/index.html';
    else if (!extname(path)) path += '.html';
    const file = resolve(dir, `.${path}`);
    try {
      if (!file.startsWith(dir + sep)) throw new Error('outside the site');
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${server.address().port}`;
}

async function waitUntilUp(url) {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`nothing answered on ${url}`);
}

if (!process.env.CHROMIUM_PATH) {
  console.error('Set CHROMIUM_PATH to an installed Chromium or Chrome binary (this script never downloads a browser).');
  process.exit(1);
}

const now = new Date();
const dataDir = tmpDir('cs-shots-');
const siteDir = tmpDir('cs-shots-site-');
const app = createApp({
  store: createStore(join(dataDir, 'db.json')),
  mailer: createMailer({ outbox: join(dataDir, 'outbox.jsonl') }),
  fetch: sampleVendors(now),
  billing: { paymentLink: PLACEHOLDER_PAYMENT_LINK },
});
const site = staticSite(siteDir);
const base = await listen(app);
await waitUntilUp(`${base}/api/usage`);
const api = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
try {
  const open = async (options) => {
    const context = await browser.newContext(options);
    await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort()); // never leave the machine
    return context.newPage();
  };
  const desktop = await open({ viewport: { width: 1280, height: 800 } });
  const phone = await open({ ...devices['iPhone 13'] });
  const pages = [[desktop, 'desktop'], [phone, 'mobile']];
  const ready = async (page) => {
    await page.waitForFunction(() => !document.getElementById('status').textContent.startsWith('Loading'));
    await page.waitForLoadState('networkidle');
  };
  // where: null for the top, 'bottom', or a selector to scroll to the top of the viewport.
  const shot = async (page, name, where = null) => {
    if (where === 'bottom') await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    else if (where) await page.locator(where).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
    else await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    console.log(`saved docs/screenshots/${name}.png`);
  };
  // Controls that must stay hidden until they mean something (a `display` rule once overrode `hidden`), and ones that must show.
  const assertHidden = async (page, ids) => {
    for (const id of ids) if (await page.locator(`#${id}`).isVisible()) throw new Error(`#${id} should be hidden`);
  };
  const assertVisible = async (page, selector) => {
    if (!(await page.locator(selector).first().isVisible())) throw new Error(`${selector} should be visible`);
  };

  // 1. The core action in the dashboard, through the UI: connect a tool, set a budget with Slack, press Sync now.
  await desktop.goto(base);
  await ready(desktop);
  await assertHidden(desktop, ['branches-delete', 'manage', 'chart-box', 'pay-note']);
  await desktop.selectOption('#tool', 'claude');
  await desktop.fill('#connect input[name=apiKey]', sampleKey('claude'));
  await desktop.fill('#connect input[name=project]', 'acme/web');
  await desktop.click('#connect button');
  await desktop.waitForSelector('#connections td');
  await api('POST', '/api/connections', { tool: 'openai', apiKey: sampleKey('openai'), project: 'acme/web' });
  await api('POST', '/api/connections', { tool: 'copilot', apiKey: sampleKey('copilot'), org: 'acme', project: 'platform' });
  await api('POST', '/api/connections', { tool: 'cursor', apiKey: sampleKey('cursor'), project: 'platform' });
  await api('POST', '/api/budget', { project: 'acme/web', monthlyUsd: 600, email: 'lead@example.com' });
  await desktop.fill('#budget input[name=project]', 'platform');
  await desktop.fill('#budget input[name=monthlyUsd]', '250');
  await desktop.fill('#budget input[name=email]', 'ops@example.com');
  await desktop.fill('#budget input[name=slackWebhookUrl]', sampleHook);
  await desktop.click('#budget button');
  await desktop.waitForLoadState('networkidle');
  await desktop.click('#sync');
  await desktop.waitForFunction(() => document.getElementById('status').textContent.includes('connection'));
  await ready(desktop);

  // 2. Its result (projects against budgets, alerts sent, spend by tool), then the action itself: the synced
  //    connections and Sync now.
  for (const [page, suffix] of pages) {
    await page.goto(base);
    await ready(page);
    await assertHidden(page, ['onboarding']);
    await assertVisible(page, '#upgrade');
    await shot(page, `result-${suffix}`, suffix === 'desktop' ? null : '#projects-title');
    if (suffix === 'desktop') {
      // The landing page's picture: the dashboard's top, cropped to its 900px column.
      await page.screenshot({ path: PICTURE, clip: { x: 170, y: 0, width: 940, height: 650 } });
      console.log('saved public/dashboard.png');
    }
    await shot(page, `sync-${suffix}`, 'h2:text-is("Connections")');
  }

  // 3. The public site's start page, built after the dashboard shots so its picture is the fresh public/dashboard.png.
  buildSite(siteDir, { STRIPE_PAYMENT_LINK: PLACEHOLDER_PAYMENT_LINK });
  const siteBase = await listen(site);
  for (const [page, suffix] of pages) {
    await page.goto(siteBase);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => [...document.images].every((img) => img.complete && img.naturalWidth > 0));
    await assertVisible(page, 'a[data-buy]');
    // Desktop: the hero with Get Pro. Phone: the bottom, with the Pro plan, Get Pro and the footer links.
    await shot(page, suffix === 'desktop' ? 'home-desktop' : 'home-pricing-mobile', suffix === 'desktop' ? null : 'bottom');
  }
} finally {
  await browser.close();
  await new Promise((r) => app.close(r));
  if (site.listening) await new Promise((r) => site.close(r));
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(siteDir, { recursive: true, force: true });
}
