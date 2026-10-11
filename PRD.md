# CodeSpend — Budget alerts and spend visibility for coding agents

## Problem
Engineering teams face surprise bills from AI coding agents when usage spikes go unnoticed. Existing tools offer fragmented visibility or require manual tracking, leading to uncontrolled expenses and budget overruns.

## Target user
- Primary: Engineering leads, CTOs, or tech ops managers at mid‑size tech companies (50–500 engineers) who license AI coding agents for their teams.
- Secondary: Individual developers or freelancers who want personal budget control over their AI agent usage.

## Competitors & gap
See RESEARCH.md for detailed table. CodeSpend’s gap is unified cross‑tool usage aggregation, per‑project budgeting with flexible alerts, and granular attribution to tasks and git branches—features competitors either lack or provide only partially.

## MVP scope (5–8 bullet features)
- Connect to Claude, Cursor, Copilot, and OpenAI APIs to fetch daily token usage and costs.
- Dashboard showing spend trends per tool and per project.
- Define projects (by repo name, team, or label) and set monthly budget limits.
- Email and Slack alerts at 50%, 80%, and 100% of budget.
- Cost attribution view: break down spend by git branch and by task/ticket ID (if provided via metadata).
- Export usage data as CSV for further analysis.
- Secure storage of API keys (encrypted at rest) and OAuth where available.
- Admin view to manage multiple teams/projects (for team leads).

## Non-goals
- Real‑time blocking of agent calls (pre‑spend governance); CodeSpend focuses on visibility and alerts.
- Building a custom AI coding agent; we rely on existing agents’ usage APIs.
- Handling non‑API‑based usage (e.g., local LLMs); scope limited to major commercial agents.

## Success metrics (measurable, with numbers you can justify)
- Reduction in surprise bills: target 90% of users report no unexpected overages after 2 months of use.
- Budget adherence: 80% of projects stay within set monthly budget limits.
- Time saved: users save ≥2 hours per week on manual usage tracking.
- Customer satisfaction: NPS ≥40 after 3 months.

## Open questions
- How to reliably attribute usage to specific tasks or branches when agents do not emit metadata? Possible solution: allow users to tag sessions via a simple CLI or dashboard.
- What is the optimal look‑back window for budget alerts (e.g., rolling 7‑day vs. calendar month)? Will validate with early users.
- Whether to offer self‑hosted option for enterprises with strict data‑locality requirements.