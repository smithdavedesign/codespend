# CodeSpend: launch-ready

The product does what it did before. This pass adds a public website for it, with search and share tags, privacy and terms, a Buy button, and RepoHQ's visit beacon. `npm test`: **126 tests, 126 pass** (the 110 from M1–M3 are unchanged, and 16 are new in `test/launch.test.js`).

## The one big decision: Vercel serves a static site, not the dashboard

CodeSpend's dashboard takes vendor admin keys and has no login (see BUILD.md, Review, P1). It also needs a 4-minute timer and a disk. On a public Vercel URL, every visitor would share one ephemeral store, and anyone could:
- see the other visitors' projects, spend and alert emails;
- point their alerts at themselves;
- run syncs with their keys.

So the Vercel project serves only the **public site**, a static build made by `npm run build` (`scripts/build-site.mjs` → `site/`):

| Path | What it is |
|---|---|
| `/` | Landing page: what CodeSpend does, a picture of the dashboard (sample data), how it works, pricing, **Get Pro**, how to run it |
| `/privacy`, `/terms` | Plain policy and terms (below) |
| `/robots.txt`, `/sitemap.xml` | Indexing allowed; the sitemap lists `/`, `/privacy`, `/terms` |
| `/og.png` | The 1200×630 share image, drawn by code at build time (`src/og-image.js`: a pixel font and a PNG encoder, no packages, no copied image) |
| `/beacon.js` | The RepoHQ beacon |

`vercel.json` sets `buildCommand: npm run build`, `outputDirectory: site` and `cleanUrls`. There are no functions, so the dashboard's API can't be reached on Vercel.

The dashboard still runs self-hosted (`npm start`, bound to 127.0.0.1). It renders its pages with the same code (`src/site.js`), so its `/privacy` and `/terms` are identical. The dashboard itself is marked `noindex`.

This is not a Next.js app (it's a zero-dependency Node server), so Next's conventions (metadata, `opengraph-image`, `robots.ts`, `sitemap.ts`) don't apply. Their plain equivalents are generated at build time instead.

## What was done

1. **Search and sharing.** Every public page has:
   - a unique `<title>` and meta description;
   - Open Graph and Twitter `summary_large_image` tags with `og.png` (1200×630, with alt text);
   - a canonical URL;
   - SoftwareApplication JSON-LD with an Offer of $9.00 USD, billed monthly (`billingDuration P1M`, `unitCode MON`).

   The origin is `SITE_URL`, then Vercel's `VERCEL_PROJECT_PRODUCTION_URL`, then `https://codespend.vercel.app`. A preview build therefore still points canonical URLs at production.
2. **Privacy and terms.**
   - **Privacy:**
     - the website sets no cookies and collects nothing beyond the three beacon events, named with exactly what each carries;
     - the app stores its data on your own server, with keys encrypted (the existing text);
     - contact is through GitHub issues, with a warning never to post keys there.
   - **Terms:**
     - no warranty;
     - Free (1 tool, email alerts) and Pro at $9/month per workspace, per REVENUE.md;
     - cancel through the Stripe portal;
     - a refund on request in the first 30 days.

   REVENUE.md has no refund line, so I kept M3's 30-day refund line. Both pages link each other from the footer, and the landing page's footer links both.
3. **Payment.**
   - **Get Pro · $9/month** links to `STRIPE_PAYMENT_LINK` (or `NEXT_PUBLIC_STRIPE_PAYMENT_LINK`).
   - It appears in the landing page's hero and pricing card, and in the dashboard's pricing card.
   - Without a valid `https://buy.stripe.com/…` link, the button isn't rendered at all. The landing page then says "Checkout isn't open yet", and the dashboard keeps its M3 note.
   - No link or key is hard-coded. I kept M3's rule that only `buy.stripe.com` links are accepted, so the screenshot run uses a placeholder on that host rather than `example.com`.
4. **Visit beacon** (`public/beacon.js`, loaded on every page). It POSTs `{"slug":"codespend","kind":…,"referrer":…}` as JSON to `https://repohq.vercel.app/api/ideas/signal`:
   - fire-and-forget, with `keepalive`, `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`, so the page URL never leaves the browser;
   - **visit:** once per browser session (sessionStorage), on every page;
   - **activate:** once per browser (localStorage). **The core action is a successful "Sync now" in the dashboard**: it pulls each connected tool's spend and checks every project against its budget;
   - **checkout:** every click on a Get Pro button;
   - **referrer:** `document.referrer` only when its origin differs from `location.origin`, else `null`.

   It sends nothing in these cases:
   - when `navigator.webdriver` is true;
   - when the page wasn't built or served with `VERCEL_ENV=production`, which covers previews and every self-hosted server;
   - when `localStorage["repohq:notrack"]` is set;
   - when storage is blocked.

   **Consequence:** the dashboard only runs self-hosted, so `activate` will stay at 0 until a dashboard runs on a Vercel production deployment. That is by design under these rules; `visit` and `checkout` count from day one.
5. **Deployment.** `.provision` contains:
   ```
   vercel project codespend
   request "Stripe payment link for codespend: $9/month, per REVENUE.md"
   ```
6. **Tests** (`test/launch.test.js`):
   - the build writes every file;
   - the pages render completely, with no leftover placeholders and footer links to privacy and terms;
   - every head tag above, with unique titles and descriptions;
   - robots.txt and the sitemap;
   - Get Pro hidden without the env var, shown with a Stripe link, dropped for other links;
   - the origin and `VERCEL_ENV` rules;
   - the privacy and terms wording;
   - the PNG is valid (signature, size, CRCs, inflated length, actually drawn, deterministic);
   - the server's pages and `/beacon.js`;
   - the beacon itself, run in a sandboxed fake browser: once-per-session and once-per-browser, referrer rules, every silent case, and network failures;
   - `vercel.json` and `.provision`.
7. **Screenshots** (`npm run screenshots`, never part of `npm test`).
   - The dashboard runs with stubbed vendors and sample data. The public site is built and served locally, both with a placeholder payment link, and the browser can only reach 127.0.0.1.
   - Six PNGs:
     - `home-desktop.png`: the hero with Get Pro;
     - `home-pricing-mobile.png`: the pricing card with Get Pro and the footer links;
     - `sync-desktop.png`, `sync-mobile.png`: the core action;
     - `result-desktop.png`, `result-mobile.png`: its result.
   - The old branch-view shots were removed to stay at six. `public/dashboard.png`, the landing page's picture, comes from the same run.
   - I opened every PNG and checked it. The sandbox's Chromium has no sans-serif font, so text renders monospace; real browsers use the system font.
8. **One existing CSS bug fixed:** the dashboard's Pro price (`$9`) was drawn in small type, because the `.price span` rule also matched `#price`.

## How to check it

```
npm test                                   # 126 pass, offline
npm run build && ls site/                  # index.html privacy.html terms.html robots.txt sitemap.xml og.png beacon.js dashboard.png
STRIPE_PAYMENT_LINK=https://buy.stripe.com/test_x npm run build   # "Get Pro button: shown"
CHROMIUM_PATH=/path/to/chromium npm run screenshots
```

After the first deploy:
- `curl -s https://<domain>/robots.txt`, `/sitemap.xml` and `/og.png` all return 200.
- `view-source:` on `/`, `/privacy` and `/terms` shows the tags above.
- A link preview (Slack, X, LinkedIn's Post Inspector) shows the share image.
- In devtools, the Network tab on the production URL shows one `signal` POST per session (`visit`), and one more when you click Get Pro (`checkout`).

## Left for David

1. **Paste the Stripe payment link** (the `request` in `.provision`) into the Vercel project's environment as `STRIPE_PAYMENT_LINK`, for Production, then **redeploy**. The site is static, so the link is read at build time. It must be the `https://buy.stripe.com/…` link. If `STRIPE_PORTAL_LINK` is set on a hosted dashboard, it powers "Manage or cancel".
2. **Mark your own browser** on the production site: in the devtools console, run `localStorage.setItem('repohq:notrack', '1')`.
3. **Make sure the GitHub repo is public.** The site links to it for "Run it yourself" and for contact (issues).
4. **Optional: a custom domain.** Add it in Vercel and redeploy. Canonical URLs follow `VERCEL_PROJECT_PRODUCTION_URL`, or set `SITE_URL=https://your.domain` to pin them. If `codespend.vercel.app` was taken, Vercel's assigned domain is picked up the same way.
5. **Before taking money,** REVENUE.md's other "must be true" items are still open:
   - a hosted dashboard with a login;
   - a real-key run of each vendor, and real alerts;
   - free-plan limits, which are not enforced in code.

   Until there is a hosted dashboard, a Pro buyer means hand setup, which is what REVENUE.md plans for the first ten customers.

## Owner note ("use my Copilot-usage repo; add Claude, other LLMs, Microsoft 365")

- **Claude, OpenAI, Copilot and Cursor** are tracked, plus Claude Code spend per git branch.
- **Microsoft 365 Copilot** is still out: it has no spend or token API, only a per-seat licence.
- **The other repo** isn't reachable from this sandbox, so everything stays in this one.

## Unverified (no web access here)

- **RepoHQ's CORS.** A JSON POST from another origin needs a CORS preflight. I assume the signal endpoint answers it. If it doesn't, events are dropped silently and the page is unaffected.
- **Vercel settings.** I assume `framework: null` with `outputDirectory: site` deploys as a plain static site, and that Vercel exposes `VERCEL_ENV` and `VERCEL_PROJECT_PRODUCTION_URL` at build time (its documented default).

## Self-review (gstack pre-landing checklist)

I reviewed `git status` and `git diff` against "Review Categories" and "Fix-First Heuristic".

**CRITICAL: none found.**
- **SQL, races, LLM trust boundary, shell:** none of these paths exist in the change.
- **Unsafe HTML:**
  - every value that reaches a page is escaped: titles, descriptions, URLs, `data-env`, the payment link and the contact email;
  - the JSON-LD escapes `<`;
  - the payment link must be `https://buy.stripe.com/…`;
  - placeholders are filled with function replacers, so `$&` stays literal.
- **Enum completeness:** the three event kinds, the four page keys and the public-page list were traced through the renderer, the build, the server routes, the sitemap and the beacon.

**Fixed (auto-fix):**
- [P3] (9/10) BUILD.md still said there would be no Vercel project and described the old `.provision`. Updated.
- [P3] (9/10) `src/og-image.js` exported two helpers nobody uses. Made them internal.
- [P3] (8/10) The landing page's install command overflowed on phones. Seen in a screenshot, now wrapped.
- [P3] (8/10) The dashboard's `$9` was drawn small, a CSS rule that predates go-live. Seen in a screenshot.

**Open (ASK-type, for the owner):**
- [P1] (8/10) The dashboard still has no login, which is why it isn't deployed (carried over from M2/M3).
- [P2] (6/10) The beacon's `application/json` POST depends on RepoHQ allowing a CORS preflight (see Unverified).
