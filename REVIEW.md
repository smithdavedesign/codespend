**Verdict: pass. Score 3/10.** A crowded spend-alert category with a buyer David can't reach at $0, and his own pr-receipt idea is the sharper version.

## Forcing questions

**Q1 Demand reality: 2/10.** The only evidence is two Claude Code GitHub issues (#81703, #62338) on disputed bills. That is pain, but it is complaints about billing, not requests for a third-party tool. "Evidence they pay" in RESEARCH.md is competitors' waitlists and early access, which is interest, not money. Nobody named, nobody paying, nobody upset at its absence. Stronger evidence would be: 5+ engineering leads who can describe their last surprise bill and offer to pay or connect a key.

**Q2 Status quo: 4/10.** Teams use vendor consoles (Anthropic usage report, Cursor team spend limits, Copilot metrics, OpenAI budget limits) and spreadsheets. Per-vendor caps and alerts already exist. The unified view is a convenience, and most teams use only one or two agents.

**Q3 Desperate specificity: 2/10.** "Engineering leads, CTOs, tech ops managers at 50–500 engineer companies" is a category. No name, no consequence: a $700 tooling bill doesn't get anyone fired. Individual developers have no budget, and ccusage-style free tools serve them.

**Q4 Narrowest wedge: 4/10.** M1 (Claude usage, Postgres, chart, email at 100%) is small but duplicates console limits. The differentiator, branch/task attribution, is pushed to M3 and is the hard part, because billing APIs report by key/user/day, not branch. The 8-bullet MVP is a platform.

**Q5 Observation (pre-product).** Watch M1 users: do they open the dashboard after the first alert or only react to the email? Do they hesitate at pasting an admin key? Do they ask for branch attribution before anything else? Do they already have a vendor cap set?

**Q6 Future-fit: 3/10.** Vendors keep adding native budgets and analytics, which commoditises a read-only aggregator. Metered pricing grows the problem, but the value accrues to vendors or to agent-level governors, not a dashboard.

## Premises
1. Teams are hurt by surprise AI coding bills: weakly supported (two anecdotes, one is a vendor billing bug).
2. Vendor-native budgets are insufficient: not supported; the research never checked them.
3. Cross-tool aggregation is a must-have: unverified.
4. Mid-size leaders will hand a solo vendor admin keys: doubtful.
5. Branch attribution is possible from billing APIs: not supported (the research's own open question).

## Alternatives
- **A. Extend pr-receipt (recommended).** Local session logs to a per-branch cost receipt on the PR. Effort S–M, risk low. No key custody, $0, delivers the attribution CodeSpend only promises. Reuses David's existing idea.
- **B. Minimal local watcher.** CLI/Action reading Claude Code logs, warns at a daily or monthly threshold. Effort S, risk low. Shareable on r/ClaudeAI to test pull.
- **C. Ideal: multi-tenant SaaS** storing admin keys for four vendors. Effort XL, risk high. Security-sensitive, unreachable for a solo $0 test.

## Narrowest wedge
Local-only: read Claude Code logs, spend per branch, one threshold alert. That is pr-receipt, not CodeSpend.

## M1 feasibility
- Weekend build: yes (Claude usage fetch, Postgres, chart, email).
- $0: **no**. SendGrid and the Anthropic Admin API need an org account and admin key, so a real end-to-end run costs money or access David lacks, and he would hold customers' keys.
- Single proving test: a seeded key returns known usage and the 100% alert fires. It proves plumbing, not demand.

## Risks
- Crowded: SpendGuard, Agentic SpendGuard, llm-spendguard, MeterCall, ccusage, plus vendor caps.
- Vendors ship native alerts, so this is a feature on their roadmaps.
- Admin APIs are org-level only, which excludes the reachable audience.
- Key custody is a trust and security liability.
- The headline pain (misattributed billing) can't be fixed by an alert tool.
- Mid-size buyer: no cheap channel in a 2-week test.
- Overlaps pr-receipt and dawnlog.

## Kill criteria
No demand test is run. If revisited, drop it if fewer than 5 named engineering leads confirm a surprise bill last quarter and would connect an admin key, or if a vendor ships native cross-tool budget alerts.

## Assignment
Don't build this. If the spend theme matters, put effort into pr-receipt and test it with a post in r/ClaudeAI.
