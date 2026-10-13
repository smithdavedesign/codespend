// npm run build: write the public site (landing page, privacy, terms, robots.txt, sitemap.xml, og.png, beacon.js)
// into site/, which Vercel serves (vercel.json). Reads SITE_URL, STRIPE_PAYMENT_LINK, CONTACT_EMAIL and Vercel's
// VERCEL_ENV / VERCEL_PROJECT_PRODUCTION_URL at build time; values are never printed.
import { fileURLToPath } from 'node:url';
import { buildSite } from '../src/site.js';

const out = fileURLToPath(new URL('../site/', import.meta.url));
const r = buildSite(out, process.env);
console.log(`Built ${r.files.length} files into site/ for ${r.origin}`);
console.log(r.hasPaymentLink ? 'Get Pro button: shown' : 'Get Pro button: hidden (STRIPE_PAYMENT_LINK is unset or not a https://buy.stripe.com/ link)');
console.log(r.env === 'production' ? 'RepoHQ beacon: on (production)' : 'RepoHQ beacon: silent (not Vercel production)');
