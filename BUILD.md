# CodeSpend — build notes

## Plan

M3 from ROADMAP.md (the last milestone of the MVP run):
- cost attribution by git branch
- CSV export
- a date-range selector and tool-specific charts
- docs and onboarding

Exit criterion: *the attribution view shows the correct branch breakdown for a test repository with known commits.*

REVENUE.md's remaining "before charging" parts also land here, because there is no later milestone: a Stripe payment link, a privacy policy and terms, and keys encrypted at rest (the privacy page has to describe key handling truthfully).

### Step 0: Scope challenge (answered without a reviewer, recorded here)

1. **What already solves part of this?**
   - Every synced vendor row is already labelled with tool, project and date (`usageRows` in `budget.js`). CSV export, the date range and the per-tool charts are filters and views over that one function; there is no new data path.
   - The page already draws a stacked SVG chart. Per-tool charts reuse the same drawing code.
   - Branch attribution has no existing source. **The billing APIs can't provide it:** Anthropic, OpenAI, GitHub and Cursor report by key, user and day, never by branch (REVIEW premise 5). So the branch has to come from the developer's machine.
2. **Minimum change for the exit criterion.** Two local facts give an exact answer:
   - **Claude Code's session transcripts** (`~/.claude/projects/*/*.jsonl`) record every model call with its timestamp, working directory, model and token counts.
   - **The repository's HEAD reflog** says which branch was checked out at every moment ("checkout: moving from A to B") and which commits were made on it.

   A small CLI (`bin/codespend-branches.mjs`) runs in a repo. It assigns each call to the branch checked out at that time, prices the tokens, and posts per-day, per-branch totals (cost, tokens, commits) to the server. The server stores them by project and shows a breakdown for a date range. "Reading current branch from local git" (ROADMAP) is taken literally: the branch comes from git's own record, not from a guess.
   - **Rejected: splitting vendor spend by commit counts.** It's simpler but wrong. An org key's spend includes every developer and every repo, and commit counts say nothing about agent effort.
   - **Rejected: using only the transcript's `gitBranch` field.** It needs no git, but the field can be stale after a mid-session checkout. It is kept as the fallback for times before the reflog starts.
3. **Complexity check:** about 12 files touched.
   - Logic: `app.js`, `store.js` and `server.js` change; `attribution.js` (the local collector), `branches.js` (server-side store and summary) and the CLI are new.
   - Static: `index.html` changes; `privacy.html` and `terms.html` are new; plus `package.json` and the screenshot script.

   That's over the 8-file line. I accepted it: the legal pages are static HTML, and splitting the collector (runs on the developer's machine) from the server side (runs on the server) is the real boundary. CSV, range and onboarding add no files. There are no classes, only functions.
4. **Search check:** Search unavailable (WebSearch and WebFetch are denied in this sandbox), so I proceeded with in-distribution knowledge only.
   - **[Layer 1]** `node:child_process.execFile` runs git (argument arrays, no shell). `node:crypto` AES-256-GCM encrypts keys. Plain string building writes CSV. No packages are added except the devDependency `playwright-core` for screenshots.
   - **[EUREKA]** The reflog is a timestamped branch history that every non-bare repo already keeps (`core.logAllRefUpdates` is on by default). It answers "which branch was this token spent on" without a git hook, a daemon or any agent cooperation. In a test, `GIT_COMMITTER_DATE` makes its timestamps deterministic.
   - The transcript format (fields `type`, `cwd`, `gitBranch`, `timestamp`, `requestId`, `message.id`, `message.model`, `message.usage`) and the per-model prices come from memory and are unverified (see "Unverified").
5. **TODOS:** there is no TODOS.md. Deferred items are listed under "Left".
6. **Completeness:** these edge cases are in, because each one is a few lines:
   - Claude Code writes one line per content block, so calls are deduped by message id plus request id.
   - Entries are filtered by `cwd` inside the repo, so subdirectories count and other repos don't.
   - Detached HEAD and rebases have their own branch states.
   - Amend and merge entries are not counted as commits.
   - A `costUSD` field written by older Claude Code versions is preferred over the price table.
   - Models without a known price count their tokens but cost $0, and the CLI says so.
   - Re-running the CLI replaces its own days instead of adding to them, and two developers posting the same project add up.
   - CSV cells that start with `= + - @` are neutralised.
7. **Distribution:** the CLI is a new artifact. It ships in this repo (`package.json` `bin`) and runs with `node bin/codespend-branches.mjs` or `npm run branches --`. It is not published to npm. That is listed under NOT in scope.

**Owner note** ("use my Copilot-usage repo, add Claude, other LLMs, Microsoft 365"):
- **Claude:** the branch view adds a second way to track Claude token spend. It reads Claude Code's local logs with no admin key, so it works for people on Max/Pro plans or without org access.
- **Copilot, OpenAI, Cursor:** done in M2.
- **Microsoft 365 Copilot:** still not done. It has no token or spend API, only a flat per-seat license.
- **The other repo:** still unreachable from this sandbox, so the work stays in this repo.

**Deliberately NOT in scope:**
- **Hosting:** login and multi-tenancy, Postgres, and a hosted deploy. The live URL REVENUE.md wants needs these; see "Left".
- **Payments beyond a link:** automatic free/paid tier gating and a Stripe webhook. REVENUE.md allows gating by hand for the first ten customers.
- **More attribution sources:** ticket-ID extraction from branch names (a PRD bullet, not in ROADMAP M3), and local logs of other agents (Cursor, Codex, Copilot).
- **Branch spend in budgets or alerts:** branch spend is a breakdown only. Counting it would double count the Anthropic connection, and Max-plan users don't pay per token.
- **Distribution:** an npm release of the CLI.
- **Microsoft 365.**

### Architecture

```
 developer machine                                              CodeSpend server (127.0.0.1)
 ─────────────────                                              ───────────────────────────
 ~/.claude/projects/*/*.jsonl ─┐                                POST /api/branches  (JSON only)
   (calls: time, cwd, model,   │   bin/codespend-branches.mjs     validate ─> store.branches[project][source]
    tokens; deduped)           ├─>  attribution.js                 .days[date] = [{branch, costUsd, tokens, commits}]
 git rev-parse --git-path      │    each call -> branch at its       (a re-run replaces its own days;
   logs/HEAD  (reflog: time,   │    timestamp; price; group by        other sources add up)
   checkout A->B, commit)  ────┘    (UTC day, branch)  ── POST ──>
                                                                GET /api/branches?project&from&to -> per-branch totals,
                                                                    share, tokens, commits, daily series
 the page (index.html)  <───── GET /api/usage?from&to: tools in range (charts), projects month-to-date (budgets),
                               onboarding flags, billing links
                         <───── GET /api/usage.csv and /api/branches.csv?from&to (attachment, formula-safe)
                         <───── GET /privacy, /terms (contact from CONTACT_EMAIL)
 store file: apiKey and slackWebhookUrl sealed with AES-256-GCM
   (key from CODESPEND_ENCRYPTION_KEY, or a 0600 secret.key next to the data file)
```

- **Branch at time t:**
  - From the reflog: the target of the last "checkout: moving from A to B" (or "returning to refs/heads/X") at or before t.
  - Before the first checkout, it is that checkout's "from" branch, or the current branch if there was never a checkout.
  - During a rebase, and for a checkout to a commit id, it is `(detached)`.
  - Before the reflog's first entry, it falls back to the transcript's `gitBranch`, then `(unknown)`.
- **Commits per branch:** reflog `commit:` and `commit (initial):` entries, counted on the branch checked out at the time. Amends are rewrites, merges join branches, and rebase picks replay, so none of them counts as a new commit.
- **Price:**
  - Each model family has an input price per million tokens. Output costs 5×, a 5-minute cache write 1.25×, a 1-hour cache write 2×, and a cache read 0.1× (Anthropic's published ratios).
  - Opus 4/4.1 and Claude 3 Opus: $15. Opus 4.5 and later: $5. Sonnet: $3. Haiku 4.5 and later: $1. Haiku 3.5: $0.80. Haiku 3: $0.25.
- **Date range:**
  - `from`/`to` are inclusive UTC dates. The default is the current calendar month, so every M2 field keeps its meaning.
  - The range is at most 366 days, and `from` must not be after `to`.
  - Budgets and the projects table stay month-to-date, because a budget is monthly.
- **Failure scenarios the plan covers:**
  - Not a git repo, or git missing: the CLI exits 1 with a clear message and posts nothing.
  - No reflog (a fresh clone, or logging off): the transcript's `gitBranch` is used and the CLI warns.
  - The server is unreachable or rejects the post: exit 1 with the status. Nothing is half-stored, because one POST is one store update.
  - A malformed transcript line (a crash mid-write): it is skipped.
  - A huge history: the CLI sends only from the first day of the previous month (`--since`). It reads transcripts one file at a time and skips files last written before `--since`. The route caps the body at 1 MB and 5,000 rows.
  - Two developers on the same project: each machine posts under its own source id (a hash of hostname and repo path), so their rows add up instead of overwriting.
  - The encryption key changes or is lost: the store refuses to start with a clear error, rather than sending garbage keys to vendors.
  - A branch name like `=HYPERLINK(...)` in CSV: the cell is prefixed with `'`.
- **Security:**
  - The CLI sends only dates, branch names, token counts, costs and commit counts. It never sends prompts, file contents, emails, names or paths.
  - Branch names are escaped in the page.
  - The new routes follow M2's rules: mutations need JSON, nothing listens beyond 127.0.0.1, and secrets are never returned.
  - Stripe links must be `https://buy.stripe.com/` or `https://billing.stripe.com/`.

### Test plan (exit criterion first; every new codepath has a test)

- **Exit criterion (`test/m3-exit.test.js`):**
  - A real temporary git repo is built with fixed commit and checkout times: `main` gets 1 commit, `feature/login` 3, `fix/typo` 1, and then it returns to `main`.
  - Claude Code transcripts are generated with calls at known times, using three models, one duplicated line, one stale `gitBranch`, one call from a subdirectory and one from another repo.
  - The real CLI runs as a subprocess against the running server.
  - `GET /api/branches` must show exactly each branch's dollars, tokens and commits, sorted by spend, with shares adding to 100%. The page must contain the branch view.
  - A second case runs the CLI twice and checks the totals don't double.
- **Collector (`test/attribution.test.js`):**
  - reflog parsing (identity with spaces, tabs in messages, malformed lines)
  - the timeline: initial branch, checkout, detached, rebase start/finish, no checkouts at all
  - commit kinds (initial, merge, amend)
  - `branchAt` before, at and after boundaries
  - the transcript parser: dedupe, `cwd` filter, `costUSD`, non-assistant lines, bad JSON, missing usage
  - every price family plus the unknown model, and the 1-hour cache
  - grouping by UTC day and `since`
  - the `gitBranch` fallback, and `(unknown)`
  - the project label from https and ssh remotes and from the folder name
  - finding transcript folders by encoded path
  - skipping old files
- **CLI (`test/cli.test.js`):**
  - `--dry-run` prints without posting
  - `--repo` and `--project` work
  - outside a repo, it exits 1
  - an unreachable server exits 1
  - a non-2xx response exits 1
  - bad options exit 1, and `--help` works
- **Server (`test/m3-app.test.js`):**
  - **branches:** validation, a re-post replaces its days, two sources add up, project selection, range filter, DELETE
  - **dashboard range:** default month, custom range, invalid input gives 400, tool range totals vs month totals
  - **CSV:** both exports have the right headers and rows, honour the range, neutralise formulas and quote fields, and send an attachment header
  - **onboarding:** the flags flip as each step is done
  - **legal pages:** `/privacy` and `/terms` are served with the contact address escaped (including `$&`)
  - **billing links:** valid Stripe links are shown and invalid ones dropped
  - **page:** it has the range picker, per-tool charts, the branch view, pricing and the legal links
- **Store (`test/store-crypto.test.js`):**
  - the data file never contains a key or webhook in plain text, and a reload decrypts it
  - an M2 plaintext file loads and is sealed on disk straight away
  - a wrong key gives a clear error
  - an env key is used, a generated key file is created 0600, and a malformed env key is refused
- **M1 and M2:** all 71 tests are kept unchanged.

## What it does now (after M3)

It's a zero-dependency Node service (Node ≥ 20.4, `node:test`) with one page at `/`, plus a small CLI.

**From M1–M2:**
- **Connect tools.** Claude (Anthropic Admin API), OpenAI (Costs API), GitHub Copilot (org billing usage) and Cursor (Admin API usage events). Each connection is labelled with a project: a repo name like `acme/web` or any tag.
- **Budgets and alerts.** Each project has a monthly budget, an alert email and an optional Slack webhook. Email and Slack alerts go out at 50%, 80% and 100%, once per threshold per channel per month.
- **Sync.** The server syncs every 4 minutes on its own, and "Sync now" does the same on demand.
- **Revoke.** Removing a connection deletes its key and its synced usage.

**New in M3:**
- **Spend by git branch.** `bin/codespend-branches.mjs` runs inside a repository.
  - It reads Claude Code's logs and the repo's reflog, charges each call to the branch checked out at the time, and posts per-day, per-branch cost, tokens and commits.
  - The **Spend by git branch** view shows, per branch: spend, share, tokens, commits and cost per commit, for any project and date range.
  - Re-running the CLI replaces its own report. Teammates' reports add up.
  - "Delete branch data" removes a project's reports.
- **Date range.** The From/To picker has This month, Last 30 days and Last month presets. It drives the totals, the stacked daily chart, the **per-tool charts** (each tool's own daily bars, total and share) and the branch view. Budgets stay month-to-date.
- **CSV export.**
  - Usage CSV: `date,tool,project,cost_usd`.
  - Branch CSV: `date,project,branch,cost_usd,tokens,commits`.
  - Both follow the range, are formula-safe, and download as attachments.
- **Onboarding.** A "Get started" checklist (connect, budget, first sync, plus optional branches) shows until the three required steps are done. README.md has the getting-started guide: where to find each vendor's key, Slack webhooks, the CLI, CSV and operator settings.
- **Pricing and legal.**
  - The pricing section shows Free (1 tool, email alerts) and Pro ($9/month per workspace).
  - **Upgrade** opens the Stripe Payment Link from `STRIPE_PAYMENT_LINK`, and **Manage or cancel** opens the customer portal from `STRIPE_PORTAL_LINK`.
  - `/privacy` and `/terms` say what is stored, who sees it, and how to delete it. They show the `CONTACT_EMAIL` address.
- **Keys encrypted at rest.**
  - Vendor keys and Slack webhooks are stored as AES-256-GCM ciphertext, using `CODESPEND_ENCRYPTION_KEY` or a generated `secret.key` (0600) next to the data file.
  - An M1/M2 data file is sealed the moment it is loaded.
  - The wrong key stops the server with a clear message.

**API:**

| Method and path | Body / query | What it does |
|---|---|---|
| `GET /api/usage` | `?from&to` | Dashboard data: `range`, `tools[].rangeUsd/monthUsd/days`, `projects`, `onboarding`, `billing`, plus the M1/M2 fields |
| `GET /api/usage.csv` | `?from&to` | Usage CSV |
| `POST /api/connections` | `{tool, apiKey, project?, org?}` | Add a connection |
| `PATCH /api/connections/:id` | `{project}` | Move a connection to another project |
| `DELETE /api/connections/:id` | – | Remove a connection, its key and its usage |
| `POST /api/budget` | `{project?, monthlyUsd, email, slackWebhookUrl?}` | Set a project budget |
| `POST /api/sync` | – | Sync now |
| `POST /api/branches` | `{project, source, rows:[{date, branch, costUsd, tokens, commits}]}` | Branch report from the CLI. It replaces this source's days. |
| `GET /api/branches` | `?project&from&to` | The branch breakdown |
| `GET /api/branches.csv` | `?project&from&to` | Branch CSV (all projects if none is given) |
| `DELETE /api/branches` | `?project` | Delete a project's branch data |
| `GET /privacy`, `GET /terms` | – | Legal pages |

All mutations need `content-type: application/json`.

## Run locally

```
npm test                         # 126 tests (110 from M1–M3, 16 from go-live), offline, no real keys
npm start                        # http://127.0.0.1:3000, syncs every 4 minutes
npm run build                    # the static public site into site/ (what Vercel serves; see LAUNCH-READY.md)
node bin/codespend-branches.mjs  # inside a repo where you use Claude Code; --dry-run to only print
npm install && CHROMIUM_PATH=/path/to/chromium npm run screenshots   # PNGs into docs/screenshots/
```

`npm install` only adds the devDependency `playwright-core`, which downloads no browser and needs no install scripts.

**Environment variables (all optional):**

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Server port |
| `DB_FILE` | `data/db.json` | Data file, written 0600 with secrets sealed |
| `CODESPEND_ENCRYPTION_KEY` | generated `secret.key` next to `DB_FILE` | 32 bytes, base64 (`openssl rand -base64 32`) |
| `STRIPE_PAYMENT_LINK` | – | `https://buy.stripe.com/…` link for the $9/month plan |
| `STRIPE_PORTAL_LINK` | – | `https://billing.stripe.com/…` customer-portal login link |
| `CONTACT_EMAIL` | – | Contact shown on `/privacy` and `/terms` |
| `SLACK_WEBHOOK_URL` | – | Fallback Slack incoming webhook |
| `SENDGRID_API_KEY` + `ALERT_FROM` | – | Real email. Without them, alerts are appended to `data/outbox.jsonl`. |
| `CODESPEND_URL` (CLI) | `http://127.0.0.1:3000` | Where the CLI posts |
| `CLAUDE_CONFIG_DIR` (CLI) | `~/.config/claude` and `~/.claude` | Where the CLI reads Claude Code logs |

## Deploy on a free tier

Same shape as M2: a long-running process with a local data file. The 4-minute timer *is* the 5-minute alert promise.

- **Your own machine:** `npm start` under systemd, pm2 or launchd. This is $0. Run the CLI in your repos against `http://127.0.0.1:3000`.
- **Always-free VM:** Oracle Cloud Always Free, or Google Cloud's e2-micro free tier.
  1. Install Node 20+ and git, clone the repo, and run `npm start` as a systemd service with `DB_FILE` on the VM's disk.
  2. Set `CODESPEND_ENCRYPTION_KEY` in the service's environment file (mode 0600), generated on the VM with `openssl rand -base64 32`. Keep a copy outside the VM: without it the stored keys can't be read, and you'd have to reconnect every tool.
  3. Set `CONTACT_EMAIL` and the Stripe links (see "Infrastructure").
  4. Keep the server bound to 127.0.0.1 and reach it with `ssh -L 3000:127.0.0.1:3000 <vm>`. With that tunnel open, developers run the CLI with the default `--server http://127.0.0.1:3000`. There is still no login (see Review).
- **Hosts that don't fit:**
  - Vercel and other serverless hosts: no long-running timer and no persistent disk, and Hobby cron runs only once a day.
  - Render free: it sleeps after 15 idle minutes and wipes its disk.

## Exit criteria

**M3:** *"Attribution view shows correct branch breakdown for a test repository with known commits."* **Passing.**

`test/m3-exit.test.js` builds a real git repository with fixed timestamps:
- `main`: 1 commit
- `feature/login`: 3 commits, interrupted by a checkout to `fix/typo`
- `fix/typo`: 1 commit
- then a return to `main`

It writes Claude Code transcripts with 6 billable calls across three models. The transcripts also contain traps:
- a duplicate line
- a stale `gitBranch`
- a call from a subdirectory
- a call from another repo
- a truncated line
- a user message

The test then runs the real `codespend-branches` CLI as a subprocess against the running server. `GET /api/branches` must return exactly the following, in this order, with shares summing to 100% and the page containing the branch view:

| Branch | Spend | Tokens | Commits |
|---|---|---|---|
| `feature/login` | $2.85 | 642,000 | 3 |
| `main` | $0.675 | 165,000 | 1 |
| `fix/typo` | $0.20 | 1,100,000 | 1 |

A second test runs the CLI twice and gets the same totals.

The other M3 items are covered by `test/attribution.test.js`, `test/cli.test.js`, `test/m3-app.test.js` and `test/store-crypto.test.js`.

**M2:** *"When usage from any connected tool exceeds the project budget, an alert is sent via both email and Slack within 5 minutes."* Still passing; its tests are unchanged.

**M1:** still passing; its 15 original tests are unchanged.

`npm test`: **110 tests, 110 pass.**

## Infrastructure

At M3, `.provision` asked for the two things below. Since go-live it asks for the Vercel project (static public site) and the Stripe payment link; see LAUNCH-READY.md. The public site's contact is the GitHub issues page, so `CONTACT_EMAIL` is only needed on a server someone runs for others.
- **Stripe:** a $9/month subscription Payment Link and the customer-portal login link, set as `STRIPE_PAYMENT_LINK` and `STRIPE_PORTAL_LINK`.
  - Stripe has no monthly fee; it charges per payment.
  - These are public URLs, not secrets. Until they are set, the pricing section says "Payments aren't set up on this server yet."
- **A contact email** for the privacy policy and terms (`CONTACT_EMAIL`). Until it is set, the pages say "the person who runs this CodeSpend server".

**Not requested:**
- No database: the JSON file store is kept.
- No Google API.
- No Vercel project for the app, because Vercel doesn't fit the 5-minute timer (see Deploy). Since go-live, Vercel serves only the static public site: the landing page, privacy and terms. See LAUNCH-READY.md.
- No encryption key from the broker: locally it is generated, and on a VM it is generated on the VM.

## Unverified (no web access in this sandbox; check with real data before charging)

**M3, Claude Code logs.** These come from memory and are not checked against a current Claude Code:
- The folder layout (`projects/<cwd with non-alphanumerics as '-'>/*.jsonl`, under `~/.claude` or `~/.config/claude`).
- The line fields: `type: "assistant"`, `cwd`, `gitBranch`, `timestamp`, `requestId`, `message.id`, `message.model`, and `message.usage.*` including `cache_creation.ephemeral_1h_input_tokens`.
- That one API call is written as several lines with the same usage.
- If the format changed, the CLI reports **0 calls** rather than wrong numbers. Tokens are counted straight from the log.

**M3, prices.**
- Anthropic list prices per model family are as I know them. Families newer than my knowledge (Opus 5.x, Sonnet 5.x) are priced like the latest family I know. Other names (for example `claude-fable-5-1`) are unpriced: they cost $0 and the CLI warns.
- Long-context surcharges and batch or regional pricing are ignored.
- Max/Pro subscribers don't pay per token at all, so for them the branch dollars are list-price equivalents.

**M3, reflog messages.** The messages for checkout, rebase start/finish/abort and commit were checked against this sandbox's git for the cases in the tests. Other git versions and tools that write HEAD (some GUIs) may use other wording. Unknown messages keep the current branch.

**M3, symlinks.** If Claude Code records a path through a symlink, it won't match git's resolved path, and those calls aren't found.

**M2, vendor APIs.** The vendor API shapes (Copilot billing usage, Cursor usage events, OpenAI costs, Anthropic cost report) are still unverified. See the M2 appendix.

## Decisions and deviations from ROADMAP

- **Branch attribution covers Claude Code only.** It is the one agent I know writes per-call tokens, time and folder locally. Vendor billing APIs can't attribute by branch. The view says "Claude Code spend" so nobody reads it as the whole bill.
- **The reflog wins over the transcript's `gitBranch`.** It is git's own record and stays right after a mid-session checkout. `gitBranch` is the fallback before the reflog starts.
- **Branch spend is not in budgets.** It would double count the Anthropic connection, and it is a list-price estimate.
- **REVENUE.md parts pulled into M3:** the Stripe payment and portal links (links only, no webhook), the privacy policy and terms, and encryption at rest.
- **The free plan isn't enforced in code.** REVENUE.md says gate by hand for the first ten customers. Enforcing it needs accounts or licence checks (see Review).
- **The screenshots run the app in-process** with the vendor APIs stubbed by sample data, because there are no real keys here. The UI, the sync, the alerts and the CLI are all real. The sandbox's Chromium has no sans-serif font, so the PNGs use a monospace fallback; real browsers use the system font.
- **Storage is still the JSON file,** to keep the stack and $0.
- **Owner note:** Microsoft 365 is still out (no spend API), and the work is still in this repo, not the owner's Copilot repo.

## Left

- **Before charging** (REVENUE.md "must be true"):
  - **A live URL with a login.** It needs authentication or an access token (which also closes the DNS-rebinding gap) and an always-on host: a free VM now, and Postgres (Neon free) once there are several workspaces.
  - **The Stripe links set** (the payment link is requested in `.provision`; see LAUNCH-READY.md).
  - **A real-key run of every vendor**, and real 50/80/100% alerts observed on live usage.
  - **One real Claude Code log run of the CLI** (see "Unverified").
  - **A free email transport.** SendGrid may have no free plan; Slack is the $0 channel that reaches people today.
- **Not planned yet:**
  - ticket IDs from branch names
  - other agents' local logs (Codex CLI, Cursor)
  - a per-branch daily chart
  - Microsoft 365 seat costs
  - per-workspace filters inside one org key
  - Cursor billing cycles
  - a daily full-month vendor re-read
  - an npm release of the CLI
  - automatic plan gating through a Stripe webhook

## Review

The M3 diff was self-reviewed against gstack's checklist ("Review Categories", "Fix-First Heuristic"). After the fixes the suite was rerun: 110 of 110 pass.

**Fixed:**
- [P1] (9/10) `src/branches.js` `isDate`: an impossible date such as `2026-13-01` made `toISOString()` throw, giving a 502 instead of a 400. A test caught it, and it now returns false.
- [P2] (9/10) `src/app.js` `parseProject` (also present in M2): `__proto__` was accepted as a project label, so `s.projects['__proto__'] = …` replaced the object's prototype instead of storing a budget. `__proto__`, `constructor` and `prototype` are now refused as project labels and as CLI source ids. Tested.
- [P2] (9/10) `src/app.js` legal pages: `replaceAll` with a string expanded `$&` sequences in `CONTACT_EMAIL`. It now uses a function replacer. Tested.
- [P2] (8/10) `src/attribution.js` `collect`: every transcript was held in memory at once, which could exhaust memory for heavy users. Files are now read one at a time, and files last written before `--since` are skipped. Tested.
- [P2] (9/10) `public/index.html`: `button{display:inline-block}` overrode the `hidden` attribute. "Delete branch data" showed with no data, and **Upgrade** would have shown as a dead link with no payment link set. Seen in a screenshot. Fixed with `[hidden]{display:none !important}`. A page test guards it, and the screenshot run now fails if those controls are visible when they shouldn't be.
- [P2] (8/10) `public/index.html`: after an invalid date range, every later action failed until a reload. The range now resets on a server error, and From ≤ To is checked in the page.
- [P3] (8/10) `public/index.html`: tables were cut off on phones. Minor columns are hidden on narrow screens and long names wrap (seen in the screenshots).

**Open (ASK-type, for the owner):**
- [P1] (8/10) **No authentication** (carried over from M2).
  - It now also covers `POST`/`DELETE /api/branches`: anyone who can reach the port can change budgets, alert targets, connections and branch data. Keys can't be read back.
  - It is bound to 127.0.0.1, and the JSON-only rule blocks cross-site posts. DNS rebinding is still possible.
  - A login or access token is required before any public deploy.
- [P2] (7/10) **Free-plan limits aren't enforced.** The pricing section and the terms describe them, but REVENUE.md allows manual gating for the first ten customers. This is a design decision.
- [P2] (7/10) **Default key location.** The generated `secret.key` sits next to `db.json`. That protects a leaked or copied data file, not a stolen data folder. Use `CODESPEND_ENCRYPTION_KEY` from another place for real separation.
- [P2] (6/10) **Unverified transcript format and prices** (see above). A format change shows as 0 calls; a wrong price shows as wrong dollars, while tokens stay right.
- [P2] (6/10) **Branch days are UTC days.** That matches the budgets, but evening work in the Americas lands on the next day.
- [P3] (5/10) **Tag checkouts.** `git checkout v1.2` looks like a branch called `v1.2` in the reflog, so it shows as a branch, not as `(detached)`.
- [P3] (5/10) **Commits are counted per checkout.** A teammate's commits appear only once they run the CLI themselves.
- **Still open from M2:**
  - unverified vendor shapes (a wrong product filter shows $0)
  - UTC months vs vendor billing cycles and reporting delay
  - Cursor counting included-plan token cost
  - a one-day re-read window
  - `monthSpend` in `budget.js`, used only by an M1 test

---

## Appendix: M2 plan (summary, for reference)

M2 added Cursor, Copilot and OpenAI next to Claude, project labels, a unified dashboard and Slack alerts. Exit criterion: *an over-budget alert by email and Slack within 5 minutes.*

```
 every 4 min (setInterval, skip if busy) ─┐
 POST /api/sync ("Sync now") ─────────────┴─> syncer.run()   (calls queued: never two at once)
             Promise.allSettled per connection, one 45 s vendor deadline per sync
             providers.js: claude | openai | copilot | cursor -> [{date, costUsd}] (shape-checked)
                         store: usage[connectionId][date] = costUsd   (JSON file, atomic write)
             per project: month spend vs monthlyUsd -> highest of 50/80/100% crossed
                    email ──┬── Slack    alerted["month|project|channel"] = level (each channel retried on its own)
```

**Failure handling:**
- A vendor 401 or 500 sets `lastError`, and the others carry on.
- A hung vendor is cut off by the 45 s deadline.
- If Slack fails, the email still goes, and only Slack retries.
- The timer and the button are queued, so there is no double alert.
- Writes are crash-safe (tmp file plus rename).
- Cursor paging is capped at 200 pages and fails loudly past that.
- The window includes today.

**Security:**
- Keys and webhooks are never returned.
- The Slack URL must be on `hooks.slack.com`, and the GitHub org is validated.
- Mutations need JSON, and request bodies are capped at 64 KB.
- Every dynamic value in the page is HTML-escaped.

**M2 unverified vendor shapes:**
- **Copilot:** `GET /organizations/{org}/settings/billing/usage` with `usageItems[].netAmount`, where `product` contains "Copilot". It's unknown whether seat charges appear there.
- **Cursor:** `POST /teams/filtered-usage-events`, using `tokenUsage.totalCents`, `requestsCosts` at $0.04, and the "Not Charged" kinds.
- **OpenAI:** `GET /v1/organization/costs` with `limit=31`.
- **Anthropic:** the cost report returns `amount` in cents.
