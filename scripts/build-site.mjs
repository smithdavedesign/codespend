// npm run build: write the public site (landing page, privacy, terms, robots.txt, sitemap.xml, og.png, beacon.js)
// into site/, which Vercel serves (vercel.json). Reads SITE_URL, STRIPE_PAYMENT_LINK, CONTACT_EMAIL, Vercel's
// VERCEL_ENV / VERCEL_PROJECT_PRODUCTION_URL and NEXT_PUBLIC_DEPLOY_ENV at build time; values are never printed.
// npm run cf:build: the same site for the Cloudflare Worker (wrangler.jsonc serves site/ as static assets), counted as
// production, plus site/_headers with vercel.json's headers.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, headersFile } from '../src/site.js';

const out = fileURLToPath(new URL('../site/', import.meta.url));
const r = buildSite(out, process.env);
if (process.argv.includes('--cloudflare')) {
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  writeFileSync(join(out, '_headers'), headersFile(vercel));
  r.files.push('_headers');
}
console.log(`Built ${r.files.length} files into site/ for ${r.origin}`);
console.log(r.hasPaymentLink ? 'Get Pro button: shown' : 'Get Pro button: hidden (STRIPE_PAYMENT_LINK is unset or not a https://buy.stripe.com/ link)');
console.log(r.env === 'production' ? 'RepoHQ beacon: on (production)' : 'RepoHQ beacon: silent (not production)');
