# CodeSpend: road to first revenue

**Honest read: the evidence says nobody has been shown to pay for this.** The review scored it 3/10 and said not to build it. David chose to build anyway, folding it into his existing Copilot-usage repo. This plan is the best case, with a low price and an early kill.

Evidence strength: weak. It rests on two Claude Code GitHub billing complaints, competitor pages and my searches. There are no named buyers and no one has offered money.

## Who pays
Not the "50-500 engineer CTO". That buyer needs a sales cycle, security review and admin-key custody, and David can't reach them at $0.

The best reachable buyer is **the person who owns the AI coding bill at a 3-30 developer team**. That is a founder, tech lead or freelancer-run agency paying for an Anthropic API/Team org plus Copilot or Cursor seats, and they can expense $9 without asking anyone. I can't name one person. Finding five is the first job (see First ten users).

## What they pay today
- **$0**: vendor consoles (Anthropic Console usage/cost tabs with per-workspace spend limits, Cursor team spend limits, Copilot metrics, OpenAI budget limits) and spreadsheets.
- **$0**: free local trackers (ccusage, CodeBurn, RepoSpend, BurnRate). They only look back, with no proactive alerts, but they are free.
- **~$9 once**: AI Usage Tracker, a signed macOS build of an MIT-licensed local dashboard. This is the only paid price I found for the individual tier.
- **$99/mo** for SpendGuard Growth, per the research file. I did not verify it, and it is a different, governance-oriented product.
- Team-level tools (Port, Span, gateways like LiteLLM and Bifrost) are enterprise or self-run, with no published entry price. I found none.

The price anchor is therefore near zero for individuals and unknown above that.

## Narrowest version worth paying for
One thing the free tools don't do: **a hosted, always-on alert that pings Slack or email at 50/80/100% of a monthly budget across your Anthropic org and Copilot, without anyone running a CLI.**

- Not in scope until someone asks: branch/task attribution (billing APIs don't report by branch), Cursor and OpenAI, M365, CSV, admin views.
- Needs admin keys, so use read-only keys, encrypt them at rest, and say plainly what is stored.
- Bonus push: no login at all for the first test, only a pasted key and an email address. If you can't get that to work, a login is not the next fix.

## Price
**$9/month per workspace, flat, with a free tier of one tool and email-only alerts.**

- It sits at the only paid anchor I found ($9) and far under the $99 tier.
- It is low on purpose, because the evidence for willingness to pay is thin.
- Monthly beats one-time because the product costs to run (polling and alerts).
- A $9 charge is small enough that a lead can put it on a card without approval.

## Payment
Stripe Checkout payment link for a subscription, with the Stripe customer portal for cancellation. Gate the paid tier by email match from the webhook, or by hand for the first ten customers.

## Must be true before asking anyone to pay
- A live URL on a free tier that works end to end with a real Anthropic org key and a real Copilot org.
- The 50/80/100% alerts verified with real usage, not only a seeded key.
- Stripe link, privacy policy and terms (including key handling and deletion on request).
- A visible "revoke your key here" step.

## Launch channels
- r/ClaudeAI: the Claude Code spend complaints live here.
- Hacker News "Show HN": the competing BurnRate launched there.
- The two GitHub issues (#81703, #62338): reply only where it is useful and not spammy.
- Product Hunt: RepoSpend and AI Usage Tracker launched there, so you can see what works for competitors.

## First ten users
1. Spend a week finding five named people. Read the commenters on the two GitHub issues and on the BurnRate and RepoSpend threads. Message those who describe a surprise bill and ask for a 15-minute call.
2. Offer free setup in exchange for watching them connect a key. Watch whether they hesitate.
3. Post once in r/ClaudeAI with the live alert demo. Ask for people who would connect a key.
4. Charge the first five $9 by hand through the Stripe link. A refusal at $9 is the answer.

## Risks
- Vendors add native cross-tool alerts, or already have enough (per-workspace limits, Cursor caps).
- Most teams use one or two agents, so cross-tool value is small.
- Admin keys are a trust liability, and a solo vendor holding them is a hard sell.
- Free local trackers cover individuals, who have no budget.
- Overlaps David's pr-receipt idea, which is the sharper wedge (local logs, per-branch receipts, no key custody).
- Time spent here is time not spent on pr-receipt.

## Kill criteria
Stop if, after 3 weeks of outreach, fewer than 5 named leads confirm a surprise bill last quarter and would connect a read-only key, or if nobody pays $9 within 5 conversations. Stop immediately if a vendor ships native cross-tool budget alerts. Then move the effort to pr-receipt.

Sources: [Port](https://www.docs.port.io/guides/all/track-ai-coding-assistants-costs/), [AI Usage Tracker](https://www.producthunt.com/p/claude-usage-tracker/ai-usage-tracker), [Span](https://span-knowledge-base.help.usepylon.com/articles/3009327773-ai-tool-spend-report), [dev toolkit on cost tracking](https://developertoolkit.ai/en/ecosystem/observability/agent-cost-tracking/), [BurnRate on HN](https://hn.svelte.dev/item/47284701), plus the research file.
