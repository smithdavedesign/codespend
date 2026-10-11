# CodeSpend — Budget alerts and spend visibility for coding agents

## Summary
Unexpected AI coding agent bills shock teams when usage spikes go unnoticed. CodeSpend aggregates usage across Claude, Cursor, Copilot, and OpenAI APIs, enforces per-project budgets, and alerts via email/Slack before overspend. It attributes cost to tasks and git branches to pinpoint cost drivers.

## Evidence of the problem
- Developers report surprise bills from Claude Code due to runaway sessions or billing misattribution (e.g., $704 disputed, $447 billed to API instead of Max subscription)【https://github.com/anthropics/claude-code/issues/81703】【https://github.com/anthropics/claude-code/issues/62338】.
- Teams lack visibility into token usage and costs across multiple AI coding tools, leading to uncontrolled expenses.
- Manual tracking of usage is error‑prone and time‑consuming.

## Who pays
- **Buyer**: Engineering leads, CTOs, or tech ops managers at software companies that use AI coding agents.
- **Price point**: Competitors charge $29–$99/mo base plus a percentage of saved spend (e.g., EvidenceDesk: $29/mo + 12% of recovered amounts)【https://evidencedeskai.com/】; analogous AI spend tools like SpendGuard list pricing tiers (free starter, $99/mo growth)【https://temperstone.net/coding-spend-guard】.
- **Evidence they pay**: Existing products SpendGuard, Agentic SpendGuard, and llm‑spendguard are marketed and have waitlists or early access, indicating willingness to pay for AI spend visibility【https://temperstone.net/coding-spend-guard】【https://agenticspendguard.dev/】【https://www.llmspendguard.com/】.

## Competitors & alternatives
| Name | Price | Gap |
|------|-------|-----|
| SpendGuard (Temperstone) | Free starter; $99/mo Growth | Focuses on alerts and visibility but lacks deep per‑task/branch attribution and cross‑tool usage aggregation beyond basic APIs. |
| Agentic SpendGuard | Unknown (open source with paid tiers) | Emphasizes pre‑spend governors and atomic ledgers; may be over‑engineered for simple budgeting needs. |
| MeterCall | Free tier; paid plans | Provides usage alerts and spend caps but limited to specific tools and lacks unified dashboard across agents. |
| Manual spreadsheets | Free | Error‑prone, not real‑time, no automated alerts. |

## Technical notes
- Claude provides organization‑level usage analytics via `/v1/organizations/analytics/usage_report`【https://platform.claude.com/docs/en/api/admin/analytics/usage】.
- Cursor offers filtered usage events API for teams【https://cursor.com/docs/api】.
- GitHub Copilot exposes usage metrics through REST endpoints【https://docs.github.com/en/rest/copilot/copilot-usage】.
- OpenAI supplies usage and cost APIs for organizations【https://help.openai.com/en/articles/6614209-how-do-i-check-my-token-usage】.
- Aggregation can be done in a backend service (Node.js/Python) that stores daily usage in a Postgres database and evaluates budget thresholds.
- Alerts sent via email (SendGrid) and Slack webhooks.

## Risks & open questions
- Provider APIs may change or introduce fees for usage data; need to monitor and adapt.
- Accurate attribution of cost to specific tasks or branches requires integrating with IDE/VCS hooks or relying on user‑tagged sessions.
- Privacy: handling API keys and usage data securely is critical; must ensure encryption at rest and in transit.
- Open question: How to attribute usage when multiple agents share the same API key (e.g., organization‑wide Claude OpenAI key)?

## Sources
- https://github.com/anthropics/claude-code/issues/81703
- https://github.com/anthropics/claude-code/issues/62338
- https://temperstone.net/coding-spend-guard
- https://platform.claude.com/docs/en/api/admin/analytics/usage
- https://cursor.com/docs/api
- https://docs.github.com/en/rest/copilot/copilot-usage
- https://help.openai.com/en/articles/6614209-how-do-i-check-my-token-usage
- https://evidencedeskai.com/
- https://agenticspendguard.dev/
- https://www.llmspendguard.com/