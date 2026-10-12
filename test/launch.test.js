// Go-live: the public site (pages, share tags, robots.txt, sitemap.xml, share image), the Get Pro button, the
// RepoHQ beacon and the deployment files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import vm from 'node:vm';
import { createStore } from '../src/store.js';
import { buildSite, siteOrigin, vercelEnv, paymentLink, PAGES, PUBLIC_PAGES, DEFAULT_SITE_URL } from '../src/site.js';
import { ogImagePng, crc32, OG_WIDTH, OG_HEIGHT } from '../src/og-image.js';
import { fakeVendors, fakeMailer, startApp, tmpFile } from './helpers.js';
import { tmpDir } from './repo-fixture.js';

const ORIGIN = 'https://codespend.example.org';
// A placeholder built at runtime, not a real payment link.
const PAY = ['https://buy.stripe.com', `test_${'Q7w8E9r0'.repeat(2)}`].join('/');
const ROOT = new URL('../', import.meta.url);

function build(env = {}) {
  const dir = tmpDir('cs-site-');
  const result = buildSite(dir, { SITE_URL: ORIGIN, ...env });
  return { dir, result, read: (f) => readFileSync(join(dir, f), 'utf8') };
}
const decode = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const meta = (html, name) => {
  const m = html.match(new RegExp(`<meta (?:property|name)="${name.replace(/[.:]/g, '\\$&')}" content="([^"]*)">`));
  return m ? decode(m[1]) : undefined;
};
const title = (html) => decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '');
const jsonLd = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
const footer = (html) => html.match(/<footer>[\s\S]*?<\/footer>/)?.[0] ?? '';
const count = (s, needle) => s.split(needle).length - 1;

// ---------- the static site (npm run build) ----------

test('the build writes every public page, robots.txt, sitemap.xml, the share image, the beacon and the dashboard picture', () => {
  const { dir, result } = build();
  for (const f of ['index.html', 'privacy.html', 'terms.html', 'robots.txt', 'sitemap.xml', 'og.png', 'beacon.js', 'dashboard.png']) {
    assert.ok(existsSync(join(dir, f)), f);
    assert.ok(result.files.includes(f), f);
  }
  assert.equal(result.origin, ORIGIN);
});

test('the pages render: complete HTML, no placeholder left, the landing page explains the product and links its legal pages', () => {
  const { read } = build({ STRIPE_PAYMENT_LINK: PAY });
  for (const key of PUBLIC_PAGES) {
    const html = read(PAGES[key].out);
    assert.match(html, /^<!doctype html>\n<html lang="en">/, key);
    for (const left of ['<!--HEAD-->', '<!--BUY:', '<!--CONTACT-->']) assert.equal(html.includes(left), false, `${key}: ${left}`);
    assert.match(footer(html), /href="\/privacy"/, key);
    assert.match(footer(html), /href="\/terms"/, key);
  }
  const home = read('index.html');
  for (const words of [/Budget alerts for your AI coding spend/, /Claude/, /OpenAI/, /Copilot/, /Cursor/, /50%, 80% and 100%/, /id="pricing"/, /\$9<span>\/month per workspace/, /src="\/dashboard.png"/]) {
    assert.match(home, words);
  }
});

test('every public page has a unique title and description, Open Graph and Twitter tags with the 1200×630 image, a canonical URL and JSON-LD with the $9/month offer', () => {
  const { read } = build();
  const titles = new Set();
  const descriptions = new Set();
  for (const key of PUBLIC_PAGES) {
    const html = read(PAGES[key].out);
    const url = ORIGIN + PAGES[key].path;
    assert.equal(title(html), PAGES[key].title, key);
    titles.add(title(html));
    descriptions.add(meta(html, 'description'));
    assert.ok(meta(html, 'description').length > 50, key);
    assert.match(html, new RegExp(`<link rel="canonical" href="${url.replace(/[.]/g, '\\.')}">`), key);
    assert.equal(meta(html, 'og:url'), url, key);
    assert.equal(meta(html, 'og:type'), 'website', key);
    assert.equal(meta(html, 'og:title'), PAGES[key].title, key);
    assert.equal(meta(html, 'og:description'), PAGES[key].description, key);
    assert.equal(meta(html, 'og:image'), `${ORIGIN}/og.png`, key);
    assert.equal(meta(html, 'og:image:width'), '1200', key);
    assert.equal(meta(html, 'og:image:height'), '630', key);
    assert.ok(meta(html, 'og:image:alt'), key);
    assert.equal(meta(html, 'twitter:card'), 'summary_large_image', key);
    assert.equal(meta(html, 'twitter:title'), PAGES[key].title, key);
    assert.equal(meta(html, 'twitter:image'), `${ORIGIN}/og.png`, key);
    const ld = jsonLd(html);
    assert.equal(ld['@context'], 'https://schema.org');
    assert.equal(ld['@type'], 'SoftwareApplication');
    assert.equal(ld.name, 'CodeSpend');
    assert.equal(ld.url, `${ORIGIN}/`);
    assert.equal(ld.offers['@type'], 'Offer');
    assert.equal(ld.offers.price, '9.00');
    assert.equal(ld.offers.priceCurrency, 'USD');
    assert.equal(ld.offers.priceSpecification.billingDuration, 'P1M');
    assert.equal(ld.offers.priceSpecification.referenceQuantity.unitCode, 'MON');
    assert.match(html, /<script src="\/beacon.js" data-env="" defer><\/script>/, key);
    assert.equal(html.includes('noindex'), false, key);
  }
  assert.equal(titles.size, PUBLIC_PAGES.length);
  assert.equal(descriptions.size, PUBLIC_PAGES.length);
  assert.deepEqual([...PUBLIC_PAGES].sort(), ['home', 'privacy', 'terms']);
});

test('robots.txt allows indexing and points at the sitemap; the sitemap lists exactly the public pages', () => {
  const { read } = build();
  const robots = read('robots.txt');
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.doesNotMatch(robots, /Disallow/);
  assert.match(robots, new RegExp(`^Sitemap: ${ORIGIN.replace(/[.]/g, '\\.')}/sitemap\\.xml$`, 'm'));
  const sitemap = read('sitemap.xml');
  assert.match(sitemap, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(sitemap, /<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
  assert.deepEqual([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]), [`${ORIGIN}/`, `${ORIGIN}/privacy`, `${ORIGIN}/terms`]);
});

test('the Get Pro button is hidden without STRIPE_PAYMENT_LINK, shown with a Stripe payment link, and dropped for anything else', () => {
  const none = build().read('index.html');
  assert.equal(none.includes('data-buy'), false);
  assert.match(none, /Checkout isn't open yet/);

  for (const env of [{ STRIPE_PAYMENT_LINK: PAY }, { NEXT_PUBLIC_STRIPE_PAYMENT_LINK: PAY }]) {
    const html = build(env).read('index.html');
    assert.equal(count(html, `<a class="btn primary" href="${PAY}" data-buy>Get Pro · $9/month</a>`), 2, Object.keys(env)[0]);
    assert.equal(html.includes("Checkout isn't open yet"), false);
  }
  for (const bad of ['https://evil.example/pay', 'http://buy.stripe.com/x', 'javascript:alert(1)', 'https://buy.stripe.com/', '']) {
    assert.equal(build({ STRIPE_PAYMENT_LINK: bad }).read('index.html').includes('data-buy'), false, bad);
  }
  assert.equal(paymentLink({}), null);
  // The legal pages never carry a Buy button.
  const withLink = build({ STRIPE_PAYMENT_LINK: PAY });
  for (const f of ['privacy.html', 'terms.html']) assert.equal(withLink.read(f).includes('data-buy'), false, f);
});

test('the public origin comes from SITE_URL, then Vercel\'s production domain, then the default; VERCEL_ENV reaches the beacon tag', () => {
  assert.equal(siteOrigin({}), DEFAULT_SITE_URL);
  assert.equal(siteOrigin({ SITE_URL: 'https://spend.example.com/some/path/' }), 'https://spend.example.com');
  assert.equal(siteOrigin({ VERCEL_PROJECT_PRODUCTION_URL: 'codespend-team.vercel.app' }), 'https://codespend-team.vercel.app');
  assert.equal(siteOrigin({ SITE_URL: 'https://a.example', VERCEL_PROJECT_PRODUCTION_URL: 'b.vercel.app' }), 'https://a.example');
  for (const bad of ['http://plain.example', 'not a url', 'javascript:alert(1)', ['https://u', 'p@x.example'].join(':')]) assert.equal(siteOrigin({ SITE_URL: bad }), DEFAULT_SITE_URL, bad);

  assert.equal(vercelEnv({}), '');
  assert.equal(vercelEnv({ VERCEL_ENV: 'production' }), 'production');
  assert.equal(vercelEnv({ NEXT_PUBLIC_VERCEL_ENV: 'preview' }), 'preview');
  for (const env of ['production', 'preview']) {
    const { read } = build({ VERCEL_ENV: env });
    for (const key of PUBLIC_PAGES) assert.match(read(PAGES[key].out), new RegExp(`<script src="/beacon.js" data-env="${env}" defer>`), `${key} ${env}`);
  }
});

test('the privacy page names the three events and the terms carry the price, the refund line and no warranty; contact is GitHub issues', () => {
  const { read } = build();
  const privacy = read('privacy.html');
  for (const words of [/<strong>visit<\/strong>/, /<strong>activate<\/strong>/, /<strong>checkout<\/strong>/, /sets no cookies/, /repohq\.vercel\.app/, /referrer/]) assert.match(privacy, words);
  const terms = read('terms.html');
  for (const words of [/\$9 per month per workspace/, /first 30 days, ask for a refund/, /without warranty/, /Cancel any time/]) assert.match(terms, words);
  for (const html of [privacy, terms]) assert.match(html, /href="https:\/\/github.com\/smithdavedesign\/codespend\/issues"/);
});

// ---------- the share image ----------

test('the share image is a valid 1200×630 PNG drawn by code, the same bytes every build', () => {
  const png = ogImagePng();
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    assert.equal(png.readUInt32BE(at + 8 + len), crc32(png.subarray(at + 4, at + 8 + len)), `${type} CRC`);
    chunks.push({ type, data });
    at += len + 12;
  }
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  const ihdr = chunks[0].data;
  assert.equal(ihdr.readUInt32BE(0), OG_WIDTH);
  assert.equal(ihdr.readUInt32BE(4), OG_HEIGHT);
  assert.deepEqual([...ihdr.subarray(8)], [8, 2, 0, 0, 0]);
  const raw = inflateSync(chunks[1].data);
  assert.equal(raw.length, OG_HEIGHT * (OG_WIDTH * 3 + 1));
  const colors = new Set();
  for (let i = 1; i < raw.length; i += 3 * 97) colors.add(raw.readUIntBE(i, 3));
  assert.ok(colors.size >= 4, `drawn, not blank (${colors.size} colours sampled)`);
  assert.ok(png.length < 200_000, `${png.length} bytes`);
  assert.ok(ogImagePng().equals(png));
  assert.ok(readFileSync(join(build().dir, 'og.png')).equals(png));
});

// ---------- the self-hosted server ----------

async function server(opts = {}) {
  const store = createStore(tmpFile());
  return startApp({ store, mailer: fakeMailer(), fetch: fakeVendors(), now: () => new Date('2026-10-05T12:00:00Z'), siteUrl: ORIGIN, ...opts });
}

test('the server renders its pages with the shared head: the dashboard is noindex, privacy and terms carry share tags, /beacon.js is served', async () => {
  const t = await server();
  try {
    const dash = await t.call('GET', '/');
    assert.equal(dash.status, 200);
    assert.equal(title(dash.body), 'CodeSpend dashboard');
    assert.match(dash.body, /<meta name="robots" content="noindex">/);
    assert.match(dash.body, /<script src="\/beacon.js" data-env="" defer><\/script>/);
    assert.match(dash.body, /window\.repohq\?\.signal\('activate'\)/);
    for (const path of ['/privacy', '/terms']) {
      const page = await t.call('GET', path);
      assert.equal(page.status, 200, path);
      assert.match(page.body, new RegExp(`<link rel="canonical" href="${ORIGIN.replace(/[.]/g, '\\.')}${path}">`), path);
      assert.equal(jsonLd(page.body).offers.price, '9.00', path);
      assert.equal(meta(page.body, 'og:image'), `${ORIGIN}/og.png`, path);
    }
    const js = await fetch(`http://127.0.0.1:${t.server.address().port}/beacon.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /^text\/javascript/);
    assert.equal(await js.text(), readFileSync(new URL('public/beacon.js', ROOT), 'utf8'));
  } finally { await t.close(); }
});

test('the dashboard\'s Get Pro button stays hidden without STRIPE_PAYMENT_LINK and gets the link when it is set', async () => {
  const none = await server();
  try {
    const page = (await none.call('GET', '/')).body;
    assert.match(page, /<a id="upgrade" class="btn primary" data-buy hidden>Get Pro · \$9\/month<\/a>/);
    assert.equal((await none.call('GET', '/api/usage')).body.billing.paymentLink, null);
  } finally { await none.close(); }
  const set = await server({ billing: { paymentLink: PAY }, vercelEnv: 'production' });
  try {
    assert.equal((await set.call('GET', '/api/usage')).body.billing.paymentLink, PAY);
    assert.match((await set.call('GET', '/')).body, /data-env="production"/);
  } finally { await set.close(); }
});

// ---------- the RepoHQ beacon, run in a sandboxed fake browser ----------

const BEACON = readFileSync(new URL('public/beacon.js', ROOT), 'utf8');
const ENDPOINT = 'https://repohq.vercel.app/api/ideas/signal';

function storage(entries = {}) {
  const m = new Map(Object.entries(entries));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } };
}
const blocked = () => ({ getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } });

// One page load. Pass the same session/local storage to simulate another page in the same session or browser.
function pageLoad({ env = 'production', referrer = '', origin = 'https://codespend.vercel.app', webdriver = false, session = storage(), local = storage(), fetchImpl, script = true } = {}) {
  const sent = [];
  const listeners = {};
  const ctx = {
    URL,
    navigator: { webdriver },
    location: { origin },
    document: { currentScript: script ? { dataset: { env } } : null, referrer, addEventListener: (type, fn) => { listeners[type] = fn; } },
    sessionStorage: session,
    localStorage: local,
    fetch: fetchImpl ?? (async (url, opts) => { sent.push({ url, opts, body: JSON.parse(opts.body) }); return {}; }),
  };
  ctx.window = ctx;
  vm.runInNewContext(BEACON, ctx);
  const click = (onBuy) => listeners.click({ target: { closest: (sel) => (onBuy && sel === '[data-buy]' ? {} : null) } });
  return { sent, session, local, click, signal: (kind) => ctx.repohq.signal(kind), kinds: () => sent.map((s) => s.body.kind) };
}

test('beacon: "visit" is one keepalive POST per browser session with only slug, kind and referrer, and no cookies or page URL', () => {
  const first = pageLoad({ referrer: 'https://news.ycombinator.com/item?id=1' });
  assert.equal(first.sent.length, 1);
  const [{ url, opts, body }] = first.sent;
  assert.equal(url, ENDPOINT);
  assert.deepEqual(body, { slug: 'codespend', kind: 'visit', referrer: 'https://news.ycombinator.com/item?id=1' });
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers['content-type'], 'application/json');
  assert.equal(opts.keepalive, true);
  assert.equal(opts.credentials, 'omit');
  assert.equal(opts.referrerPolicy, 'no-referrer');
  assert.equal(pageLoad({ session: first.session, local: first.local }).sent.length, 0, 'second page, same session');
  assert.deepEqual(pageLoad({ local: first.local }).kinds(), ['visit'], 'new session');
});

test('beacon: the referrer is sent only when it is another site', () => {
  const ref = (referrer) => pageLoad({ referrer }).sent[0].body.referrer;
  assert.equal(ref('https://www.reddit.com/r/ClaudeAI/'), 'https://www.reddit.com/r/ClaudeAI/');
  assert.equal(ref('https://codespend.vercel.app/privacy?from=share'), null);
  assert.equal(ref(''), null);
  assert.equal(ref('not a url'), null);
});

test('beacon: "activate" once per browser, "checkout" on every Get Pro click and nothing for other clicks', () => {
  const b = pageLoad();
  b.signal('activate');
  b.signal('activate');
  b.click(true);
  b.click(true);
  b.click(false);
  assert.deepEqual(b.kinds(), ['visit', 'activate', 'checkout', 'checkout']);
  const later = pageLoad({ local: b.local });
  later.signal('activate');
  assert.deepEqual(later.kinds(), ['visit'], 'activate already sent from this browser');
});

test('beacon: silent for automated browsers, outside Vercel production, with repohq:notrack, or when storage is blocked', () => {
  const cases = {
    webdriver: { webdriver: true },
    preview: { env: 'preview' },
    'self-hosted (no env)': { env: '' },
    'no script tag': { script: false },
    notrack: { local: storage({ 'repohq:notrack': '1' }) },
    'notrack empty': { local: storage({ 'repohq:notrack': '' }) },
    'storage blocked': { local: blocked(), session: blocked() },
  };
  for (const [name, opts] of Object.entries(cases)) {
    const b = pageLoad(opts);
    b.signal('activate');
    b.click(true);
    assert.equal(b.sent.length, 0, name);
  }
});

test('beacon: a failing network never breaks the page', async () => {
  assert.doesNotThrow(() => pageLoad({ fetchImpl: () => { throw new TypeError('blocked by an extension'); } }).click(true));
  let rejected = 0;
  pageLoad({ fetchImpl: () => { rejected++; return Promise.reject(new Error('offline')); } }).click(true);
  await new Promise((r) => setImmediate(r));
  assert.equal(rejected, 2);
});

// ---------- deployment files ----------

test('Vercel builds the static site, and .provision asks for the project and the Stripe link', () => {
  const vercel = JSON.parse(readFileSync(new URL('vercel.json', ROOT), 'utf8'));
  assert.equal(vercel.buildCommand, 'npm run build');
  assert.equal(vercel.outputDirectory, 'site');
  assert.equal(vercel.cleanUrls, true);
  const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'));
  assert.equal(pkg.scripts.build, 'node scripts/build-site.mjs');
  assert.deepEqual(readFileSync(new URL('.provision', ROOT), 'utf8').trim().split('\n'), [
    'vercel project codespend',
    'request "Stripe payment link for codespend: $9/month, per REVENUE.md"',
  ]);
});
