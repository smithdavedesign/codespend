// Vendor adapters. Each returns [{date, costUsd}] for UTC days in [start, end) (YYYY-MM-DD, end exclusive).
// Response shapes follow each vendor's public API docs and are untested against real keys (see BUILD.md).
import { fetchClaudeUsage } from './claude.js';

const DAY_MS = 86_400_000;
const MAX_PAGES = 200; // past this, fail loudly rather than report a silently truncated (too low) spend
const CURSOR_PAGE_SIZE = 500;
const CURSOR_REQUEST_CENTS = 4; // request-priced (non-token) Cursor calls bill at $0.04 each

const ms = (date) => Date.parse(`${date}T00:00:00Z`);
const utcDate = (t) => new Date(t).toISOString().slice(0, 10);

function totals() {
  const byDate = new Map();
  return {
    add(date, usd) { byDate.set(date, (byDate.get(date) ?? 0) + usd); },
    days: () => [...byDate].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, costUsd]) => ({ date, costUsd })),
  };
}

// OpenAI organization Costs API (admin key). Buckets start at unix seconds; amount.value is USD.
export async function fetchOpenAIUsage({ apiKey, fetch = globalThis.fetch, start, end }) {
  const out = totals();
  let page = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL('https://api.openai.com/v1/organization/costs');
    url.searchParams.set('start_time', String(ms(start) / 1000));
    url.searchParams.set('end_time', String(ms(end) / 1000));
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.set('limit', '31');
    if (page) url.searchParams.set('page', page);
    const res = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
    const body = await res.json();
    for (const b of body.data ?? []) {
      if (!Number.isFinite(b.start_time)) continue;
      out.add(utcDate(b.start_time * 1000), (b.results ?? []).reduce((s, r) => s + Number(r.amount?.value || 0), 0));
    }
    page = body.has_more ? body.next_page : null;
    if (!page) return out.days();
  }
  throw new Error('OpenAI API: too many pages');
}

// GitHub enhanced-billing usage report for an org (one request per calendar month), Copilot items only.
export async function fetchCopilotUsage({ apiKey, org, fetch = globalThis.fetch, start, end }) {
  const out = totals();
  const last = utcDate(ms(end) - DAY_MS).slice(0, 7);
  for (const d = new Date(`${start.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 7) <= last; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const url = new URL(`https://api.github.com/organizations/${encodeURIComponent(org)}/settings/billing/usage`);
    url.searchParams.set('year', String(d.getUTCFullYear()));
    url.searchParams.set('month', String(d.getUTCMonth() + 1));
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'codespend' },
    });
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const body = await res.json();
    for (const item of body.usageItems ?? []) {
      const date = String(item.date ?? '').slice(0, 10);
      if (!/copilot/i.test(item.product ?? '') || date < start || date >= end) continue;
      out.add(date, Number(item.netAmount || 0));
    }
  }
  return out.days();
}

// Cursor Admin API usage events (team admin key as the Basic-auth user). Token calls carry their cost in cents;
// request-priced calls carry a request count. Errored ("Not Charged") and free Bugbot events are skipped.
export async function fetchCursorUsage({ apiKey, fetch = globalThis.fetch, start, end }) {
  const out = totals();
  const authorization = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch('https://api.cursor.com/teams/filtered-usage-events', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ startDate: ms(start), endDate: ms(end) - 1, page, pageSize: CURSOR_PAGE_SIZE }),
    });
    if (!res.ok) throw new Error(`Cursor API error: ${res.status}`);
    const body = await res.json();
    for (const e of body.usageEvents ?? []) {
      const t = Number(e.timestamp);
      if (!Number.isFinite(t) || e.isFreeBugbot || /not charged/i.test(e.kind ?? '')) continue;
      const cents = e.tokenUsage ? Number(e.tokenUsage.totalCents || 0) : Number(e.requestsCosts || 0) * CURSOR_REQUEST_CENTS;
      out.add(utcDate(t), cents / 100);
    }
    if (!body.pagination?.hasNextPage) return out.days();
  }
  throw new Error('Cursor API: too many pages');
}

export const PROVIDERS = {
  claude: { label: 'Claude (Anthropic)', fetchUsage: fetchClaudeUsage },
  openai: { label: 'OpenAI', fetchUsage: fetchOpenAIUsage },
  copilot: { label: 'GitHub Copilot', needsOrg: true, fetchUsage: fetchCopilotUsage },
  cursor: { label: 'Cursor', fetchUsage: fetchCursorUsage },
};
