# CodeSpend — Roadmap

## M1 (Buildable in a weekend)
- Core backend: fetch usage from Claude API and store in Postgres.
- Simple frontend: display daily usage chart for Claude.
- Ability to add Claude API key and set a monthly budget.
- Email alert at 100% of budget (using SendGrid).
- Exit criterion: Given a test API key that returns known usage, the system correctly logs usage, evaluates budget, and sends an alert when threshold is crossed.

## M2 (Second weekend)
- Add Cursor, Copilot, and OpenAI API integrations.
- Unified dashboard showing spend across all tools.
- Project grouping: allow user to label usage by repo name or custom tag.
- Slack alert integration.
- Exit criterion: When usage from any connected tool exceeds the project budget, an alert is sent via both email and Slack within 5 minutes.

## M3 (Optional polish)
- Cost attribution breakdown by git branch (requires reading current branch from local git or user‑provided context).
- CSV export of usage data.
- UI improvements: date range selector, tool‑specific breakdown charts.
- Docs and onboarding flow.
- Exit criterion: Attribution view shows correct branch breakdown for a test repository with known commits.