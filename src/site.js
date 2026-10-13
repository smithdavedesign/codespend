// The public pages and the static site Vercel serves.
//
//   npm run build ─> buildSite('site/', process.env)                 the self-hosted server (app.js)
//     index.html (landing), privacy.html, terms.html  ─┐              renders /, /privacy and /terms
//     robots.txt, sitemap.xml, og.png, beacon.js       │ renderPage   with the same renderPage()
//     dashboard.png (public/, from the screenshot run) └────────────────────────────┘
//
// Every public page gets a unique title and description, Open Graph and Twitter card tags with the 1200×630 share
// image, a canonical URL, SoftwareApplication JSON-LD with the $9/month offer, and the RepoHQ beacon (public/beacon.js).
// The dashboard is private: it gets a title, description, noindex and the beacon only.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { ogImagePng, OG_WIDTH, OG_HEIGHT } from './og-image.js';

export const PRICE_USD = 9; // REVENUE.md: $9/month per workspace
export const REPO_URL = 'https://github.com/smithdavedesign/codespend';
export const DEFAULT_SITE_URL = 'https://codespend.vercel.app';
export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PUBLIC = new URL('../public/', import.meta.url);
const DASHBOARD_PICTURE = new URL('dashboard.png', PUBLIC); // the landing page's picture, made by `npm run screenshots`
const OG_ALT = 'CodeSpend: budget alerts for AI coding spend across Claude, OpenAI, Copilot and Cursor';

export const PAGES = {
  home: {
    file: 'landing.html', path: '/', out: 'index.html',
    title: 'CodeSpend: budget alerts for AI coding spend',
    description: 'Track Claude, OpenAI, GitHub Copilot and Cursor spend in one place. Monthly budgets per project, with email and Slack alerts at 50%, 80% and 100%.',
  },
  privacy: {
    file: 'privacy.html', path: '/privacy', out: 'privacy.html',
    title: 'Privacy policy | CodeSpend',
    description: 'What CodeSpend collects: no cookies, three anonymous usage events on the website, and vendor keys kept encrypted on your own server.',
  },
  terms: {
    file: 'terms.html', path: '/terms', out: 'terms.html',
    title: 'Terms of service | CodeSpend',
    description: 'CodeSpend terms: the Free plan, Pro at $9 per month per workspace, cancelling, refunds in the first 30 days, and no warranty.',
  },
  dashboard: {
    file: 'index.html', path: '/', private: true,
    title: 'CodeSpend dashboard',
    description: 'AI coding spend by tool, project and git branch, against monthly budgets.',
  },
};
export const PUBLIC_PAGES = Object.keys(PAGES).filter((k) => !PAGES[k].private);

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function httpsOrigin(v) {
  if (typeof v !== 'string' || !v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password ? u.origin : null;
  } catch {
    return null;
  }
}

// SITE_URL wins; on Vercel the project's production domain is next, so a preview build still points canonical URLs
// at production.
export function siteOrigin(env = {}) {
  return httpsOrigin(env.SITE_URL)
    ?? (env.VERCEL_PROJECT_PRODUCTION_URL ? httpsOrigin(`https://${env.VERCEL_PROJECT_PRODUCTION_URL}`) : null)
    ?? DEFAULT_SITE_URL;
}

// "production", "preview" or "development" on Vercel; empty anywhere else, which keeps the beacon silent.
export const vercelEnv = (env = {}) => env.VERCEL_ENV || env.NEXT_PUBLIC_VERCEL_ENV || '';

// Stripe Checkout payment links and customer-portal links only: anything else is dropped, never rendered.
export function stripeLink(v, host) {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname === host && !u.port && !u.username && !u.password && u.pathname.length > 1 ? u.href : null;
  } catch {
    return null;
  }
}
export const paymentLink = (env = {}) => stripeLink(env.STRIPE_PAYMENT_LINK || env.NEXT_PUBLIC_STRIPE_PAYMENT_LINK, 'buy.stripe.com');

export const contactHtml = (email) => (typeof email === 'string' && EMAIL.test(email)
  ? `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`
  : 'the person who runs this CodeSpend server');

export function jsonLd(origin) {
  const price = PRICE_USD.toFixed(2);
  const data = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'CodeSpend',
    description: PAGES.home.description,
    url: `${origin}/`,
    image: `${origin}/og.png`,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Linux, macOS, Windows (Node.js 20.4 or later)',
    offers: {
      '@type': 'Offer',
      name: 'CodeSpend Pro',
      price,
      priceCurrency: 'USD',
      url: `${origin}/#pricing`,
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price,
        priceCurrency: 'USD',
        billingDuration: 'P1M',
        referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'MON' },
      },
    },
  };
  // "<" is escaped so no value can close the script element.
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

const ICON = '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22%3E%3Crect width=%2216%22 height=%2216%22 rx=%223%22 fill=%22%231d4ed8%22/%3E%3Crect x=%223%22 y=%229%22 width=%222%22 height=%224%22 fill=%22%23fff%22/%3E%3Crect x=%227%22 y=%226%22 width=%222%22 height=%227%22 fill=%22%23fff%22/%3E%3Crect x=%2211%22 y=%223%22 width=%222%22 height=%2210%22 fill=%22%23fff%22/%3E%3C/svg%3E">';

export function renderHead(key, { origin = DEFAULT_SITE_URL, env = '' } = {}) {
  const p = PAGES[key];
  const tags = [`<title>${escapeHtml(p.title)}</title>`, `<meta name="description" content="${escapeHtml(p.description)}">`, ICON];
  if (p.private) {
    tags.push('<meta name="robots" content="noindex">');
  } else {
    const url = escapeHtml(origin + p.path);
    const image = escapeHtml(`${origin}/og.png`);
    const meta = (attr, name, content) => `<meta ${attr}="${name}" content="${escapeHtml(content)}">`;
    tags.push(
      `<link rel="canonical" href="${url}">`,
      meta('property', 'og:type', 'website'),
      meta('property', 'og:site_name', 'CodeSpend'),
      meta('property', 'og:title', p.title),
      meta('property', 'og:description', p.description),
      `<meta property="og:url" content="${url}">`,
      `<meta property="og:image" content="${image}">`,
      meta('property', 'og:image:width', OG_WIDTH),
      meta('property', 'og:image:height', OG_HEIGHT),
      meta('property', 'og:image:alt', OG_ALT),
      meta('name', 'twitter:card', 'summary_large_image'),
      meta('name', 'twitter:title', p.title),
      meta('name', 'twitter:description', p.description),
      `<meta name="twitter:image" content="${image}">`,
      meta('name', 'twitter:image:alt', OG_ALT),
      `<script type="application/ld+json">${jsonLd(origin)}</script>`,
    );
  }
  tags.push(`<script src="/beacon.js" data-env="${escapeHtml(env)}" defer></script>`);
  return tags.join('\n');
}

// The Get Pro button only exists when STRIPE_PAYMENT_LINK is a valid payment link.
function buyHtml(where, link) {
  if (link) return `<a class="btn primary" href="${escapeHtml(link)}" data-buy>Get Pro · $${PRICE_USD}/month</a>`;
  return where === 'pricing' ? '<p class="muted">Checkout isn\'t open yet. Watch the GitHub repository to hear when it is.</p>' : '';
}

// opts: {origin, env (VERCEL_ENV), paymentLink, contact (HTML)}. Function replacers, so "$&" in a value stays literal.
export function renderPage(key, { origin = DEFAULT_SITE_URL, env = '', paymentLink: link = null, contact = contactHtml(null) } = {}) {
  return readFileSync(new URL(PAGES[key].file, PUBLIC), 'utf8')
    .replace('<!--HEAD-->', () => renderHead(key, { origin, env }))
    .replaceAll('<!--CONTACT-->', () => contact)
    .replace(/<!--BUY:(\w+)-->/g, (_, where) => buyHtml(where, link));
}

export const beaconJs = () => readFileSync(new URL('beacon.js', PUBLIC), 'utf8');

export const robotsTxt = (origin) => `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;

export function sitemapXml(origin) {
  const urls = PUBLIC_PAGES.map((k) => `  <url><loc>${escapeHtml(origin + PAGES[k].path)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

// Writes the static site into outDir (Vercel serves it with cleanUrls, so privacy.html answers /privacy).
export function buildSite(outDir, env = {}) {
  const origin = siteOrigin(env);
  const link = paymentLink(env);
  const opts = { origin, env: vercelEnv(env), paymentLink: link, contact: contactHtml(env.CONTACT_EMAIL) };
  mkdirSync(outDir, { recursive: true });
  const files = {};
  for (const key of PUBLIC_PAGES) files[PAGES[key].out] = renderPage(key, opts);
  Object.assign(files, { 'robots.txt': robotsTxt(origin), 'sitemap.xml': sitemapXml(origin), 'og.png': ogImagePng(), 'beacon.js': beaconJs() });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(outDir, name), body);
  copyFileSync(DASHBOARD_PICTURE, join(outDir, 'dashboard.png'));
  return { origin, hasPaymentLink: !!link, env: opts.env, files: [...Object.keys(files), 'dashboard.png'] };
}
