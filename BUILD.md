# CodeSpend M1 — build notes

**Status: tests written and code implemented, but `npm test` has NOT been run.** Bash was denied mid-session, so nothing here is verified. Run `npm test` first.

## What it does now
Zero-dependency Node service (Node ≥20, `node:test`):
- Save an Anthropic admin API key (stored in `data/db.json`, mode 0600, never returned by the API).
- Set a monthly budget and alert email.
- `Sync now` fetches the month's daily cost from the Anthropic cost report, stores it (idempotent per date), and evaluates the budget.
- At ≥100% an email alert fires once per month. Default mailer appends to `data/outbox.jsonl` ($0). Set `SENDGRID_API_KEY` and `ALERT_FROM` to send via SendGrid.
- Single page with an SVG daily-usage bar chart at `/`.

## Run locally
`npm test`, then `npm start` and open http://127.0.0.1:3000. Env: `PORT`, `DB_FILE`, `SENDGRID_API_KEY`, `ALERT_FROM`.

## Deploy on a free tier
Any free Node host with a persistent disk or volume (e.g. Fly.io free allowance, Render free web service; note Render's free disk is ephemeral, so use a volume for `DB_FILE`). Start command `npm start`. Add auth in front before exposing publicly: M1 has none.

## Exit criterion
"Given a test API key that returns known usage, the system logs usage, evaluates budget, and sends an alert when the threshold is crossed."
- Covered by `test/app.test.js` (end-to-end with faked Anthropic fetch and mailer), `test/usage.test.js`, `test/budget.test.js`, `test/mailer.test.js`. Pass/fail: **unverified (not run)**.

## Deviations from ROADMAP
- Postgres replaced by a JSON file store and SendGrid made optional, to keep $0 (REVIEW.md flagged both as non-free).
- The owner's note (reuse the existing Copilot-usage repo and add Claude, other LLMs, Microsoft 365) is outside M1 and this directory, so it is not done. M1 is Claude only.
- The cost-report response shape (`amount` in cents as a string, `next_page` pagination) is assumed from docs and untested against a real admin key.

## Left
No auth, no real-API verification, no M2/M3 (other vendors, Slack, projects, attribution, CSV). REVIEW.md recommends not building this; see its assignment.
