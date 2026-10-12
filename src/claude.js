// Anthropic Admin API cost report -> [{date, costUsd}].
// Assumption: cost_report returns `amount` as a decimal string in cents (per Anthropic docs); verify with a real admin key.
const BASE = 'https://api.anthropic.com/v1/organizations/cost_report';

export async function fetchClaudeUsage({ apiKey, fetch = globalThis.fetch, start, end }) {
  const byDate = new Map();
  let page;
  do {
    const url = new URL(BASE);
    url.searchParams.set('starting_at', `${start}T00:00:00Z`);
    url.searchParams.set('ending_at', `${end}T00:00:00Z`);
    url.searchParams.set('bucket_width', '1d');
    if (page) url.searchParams.set('page', page);
    const res = await fetch(url, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } });
    if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
    const body = await res.json();
    for (const bucket of body.data ?? []) {
      const date = bucket.starting_at.slice(0, 10);
      const cents = (bucket.results ?? []).reduce((s, r) => s + Number(r.amount || 0), 0);
      byDate.set(date, (byDate.get(date) ?? 0) + cents / 100);
    }
    page = body.has_more ? body.next_page : null;
  } while (page);
  return [...byDate].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, costUsd]) => ({ date, costUsd }));
}
