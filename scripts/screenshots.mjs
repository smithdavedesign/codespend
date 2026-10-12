// npm run screenshots: start CodeSpend, drive it with Playwright, save PNGs to docs/screenshots/, stop it.
//
// The app runs in-process with a temporary data file. The vendor APIs (Anthropic, OpenAI, GitHub, Cursor) and the
// Slack webhook are stubbed with sample data, so no real key is used and nothing leaves the machine. Branch data comes
// from the real CLI, run against a sample git repository and sample Claude Code logs.
// Chromium is never downloaded: set CHROMIUM_PATH to an installed Chromium/Chrome.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright-core';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';
import { createMailer } from '../src/mailer.js';
import { makeRepo, writeTranscripts, claudeCall, tmpDir, GIT_ENV } from '../test/repo-fixture.js';

const OUT = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
const CLI = fileURLToPath(new URL('../bin/codespend-branches.mjs', import.meta.url));
const DAY = 86_400_000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

// Sample secrets, built at runtime (never credential-shaped in the repo).
const sampleKey = (tool) => ['sample', tool, 'A1b2C3d4'.repeat(3)].join('-');
const sampleHook = ['https://hooks.slack.com/services', 'TSAMPLE', 'BSAMPLE', 'x'.repeat(12)].join('/');

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

// A sample repository with a few days of work on four branches, and the Claude Code calls made along the way.
function sampleRepo(now) {
  const start = Math.max(Date.parse(`${iso(now).slice(0, 8)}01T08:00:00Z`), now.getTime() - 5 * DAY);
  const span = now.getTime() - start - 3_600_000;
  const at = (f) => new Date(start + span * f).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const repo = makeRepo([
    { remote: 'git@github.com:acme/web.git' },
    { at: at(0), commit: 'Scaffold app' },
    { at: at(0.05), branch: 'feature/checkout-flow' },
    { at: at(0.15), commit: 'Checkout form' },
    { at: at(0.25), commit: 'Stripe session endpoint' },
    { at: at(0.3), commit: 'Checkout tests' },
    { at: at(0.33), branch: 'fix/flaky-auth-test', from: 'main' },
    { at: at(0.38), commit: 'Stabilise auth test clock' },
    { at: at(0.4), checkout: 'main' },
    { at: at(0.42), commit: 'Bump dependencies' },
    { at: at(0.45), branch: 'feature/usage-export' },
    { at: at(0.6), commit: 'CSV export endpoint' },
    { at: at(0.7), commit: 'Export button' },
    { at: at(0.72), checkout: 'feature/checkout-flow' },
    { at: at(0.85), commit: 'Address review comments' },
    { at: at(0.9), checkout: 'main' },
  ]);
  const calls = [];
  const work = [[0.06, 0.3, 'claude-sonnet-4-5-20250929', 14], [0.34, 0.38, 'claude-haiku-4-5-20251001', 6], [0.41, 0.42, 'claude-sonnet-4-5-20250929', 2],
    [0.46, 0.7, 'claude-opus-4-5-20251101', 10], [0.73, 0.85, 'claude-sonnet-4-5-20250929', 8], [0.91, 0.99, 'claude-sonnet-4-5-20250929', 3]];
  for (const [a, b, model, n] of work) {
    for (let i = 0; i < n; i++) {
      const f = a + ((b - a) * (i + 0.5)) / n;
      calls.push(claudeCall({ at: at(f), cwd: repo.dir, gitBranch: 'main', model, input: 4_000 + i * 900, output: 1_800 + i * 350, cacheWrite: 30_000 + i * 2_000, cacheRead: 220_000 + i * 40_000 }));
    }
  }
  const claudeDir = tmpDir('cs-shots-claude-');
  writeTranscripts(claudeDir, repo.dir, { 'sample-session': calls });
  return { dir: repo.dir, claudeDir, since: iso(start) };
}

async function waitUntilUp(base) {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/api/usage`)).ok) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`CodeSpend did not answer on ${base}`);
}

if (!process.env.CHROMIUM_PATH) {
  console.error('Set CHROMIUM_PATH to an installed Chromium or Chrome binary (this script never downloads a browser).');
  process.exit(1);
}

const now = new Date();
const dataDir = tmpDir('cs-shots-');
const server = createApp({
  store: createStore(join(dataDir, 'db.json')),
  mailer: createMailer({ outbox: join(dataDir, 'outbox.jsonl') }),
  fetch: sampleVendors(now),
});
server.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
await waitUntilUp(base);
const api = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
try {
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const phoneContext = await browser.newContext({ ...devices['iPhone 13'] });
  const phone = await phoneContext.newPage();
  const ready = async (page) => {
    await page.waitForFunction(() => !document.getElementById('status').textContent.startsWith('Loading'));
    await page.waitForLoadState('networkidle');
  };
  const shot = async (page, name, selector) => {
    if (selector) await page.locator(selector).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    else await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    console.log(`saved docs/screenshots/${name}.png`);
  };

  // Controls that must stay hidden until they mean something (a `display` rule once overrode `hidden`).
  const assertHidden = async (page, ids) => {
    for (const id of ids) if (await page.locator(`#${id}`).isVisible()) throw new Error(`#${id} should be hidden`);
  };

  // 1. The start page: nothing connected yet, the onboarding checklist leads the way.
  for (const [page, suffix] of [[desktop, 'desktop'], [phone, 'mobile']]) {
    await page.goto(base);
    await ready(page);
    await assertHidden(page, ['branches-delete', 'upgrade', 'manage', 'chart-box']);
    await shot(page, `home-${suffix}`);
  }

  // 2. The core action, through the UI: connect a tool, set a budget with Slack, press Sync now.
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

  // 3. Branch attribution: the real CLI on a sample repository, posting to this server.
  const repo = sampleRepo(now);
  const out = await promisify(execFile)(process.execPath, [CLI, '--server', base, '--since', repo.since], {
    cwd: repo.dir,
    env: { ...process.env, ...GIT_ENV, CLAUDE_CONFIG_DIR: repo.claudeDir },
  });
  console.log(out.stdout.trim());

  for (const [page, suffix] of [[desktop, 'desktop'], [phone, 'mobile']]) {
    await page.reload();
    await ready(page);
    await assertHidden(page, ['onboarding']);
    // Desktop: the whole top (status, projects vs budgets, chart). Phone: from the projects table down to the chart.
    await shot(page, `dashboard-${suffix}`, suffix === 'desktop' ? null : '#projects-title');
    await shot(page, `branches-${suffix}`, '#branches-title');
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  rmSync(dataDir, { recursive: true, force: true });
}
