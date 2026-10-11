import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fetchClaudeUsage } from './claude.js';
import { monthSpend, evaluateBudget } from './budget.js';

const PAGE = new URL('../public/index.html', import.meta.url);

export function createApp({ store, mailer, fetch = globalThis.fetch, now = () => new Date() }) {
  const month = () => now().toISOString().slice(0, 7);
  const status = () => evaluateBudget(monthSpend(store.days(), month()), store.get().budget?.monthlyUsd);

  async function sync() {
    const s = store.get();
    if (!s.apiKey) return { code: 400, body: { error: 'Add an API key first' } };
    const end = now().toISOString().slice(0, 10);
    const start = `${month()}-01`;
    const days = await fetchClaudeUsage({ apiKey: s.apiKey, fetch, start, end: end > start ? end : start });
    store.update((st) => { for (const d of days) st.days[d.date] = d.costUsd; });
    const st = status();
    let alerted = false;
    const b = store.get().budget;
    if (st.crossed && b?.email && !store.get().alerted[month()]) {
      await mailer.send({
        to: b.email,
        subject: `CodeSpend: Claude spend reached 100% of your $${b.monthlyUsd} budget`,
        text: `Claude spend for ${month()} is $${st.spend.toFixed(2)} against a $${b.monthlyUsd} monthly budget.`,
      });
      store.update((x) => { x.alerted[month()] = true; });
      alerted = true;
    }
    return { code: 200, body: { alerted, status: st } };
  }

  async function route(req) {
    const { method, url } = req;
    if (method === 'GET' && url === '/') return { code: 200, type: 'text/html', body: readFileSync(PAGE, 'utf8') };
    if (method === 'GET' && url === '/api/usage') {
      return { code: 200, body: { days: store.days(), status: status(), hasKey: !!store.get().apiKey, budget: store.get().budget } };
    }
    if (method !== 'POST') return { code: 404, body: { error: 'not found' } };
    if (url === '/api/sync') return sync();
    const input = await readJson(req);
    if (url === '/api/key') {
      if (typeof input.apiKey !== 'string' || !input.apiKey.trim()) return { code: 400, body: { error: 'apiKey required' } };
      store.update((s) => { s.apiKey = input.apiKey.trim(); });
      return { code: 200, body: { ok: true } };
    }
    if (url === '/api/budget') {
      const { monthlyUsd, email } = input;
      if (!(typeof monthlyUsd === 'number' && monthlyUsd > 0)) return { code: 400, body: { error: 'monthlyUsd must be > 0' } };
      if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { code: 400, body: { error: 'valid email required' } };
      store.update((s) => { s.budget = { monthlyUsd, email }; s.alerted = {}; });
      return { code: 200, body: { ok: true } };
    }
    return { code: 404, body: { error: 'not found' } };
  }

  return createServer(async (req, res) => {
    let out;
    try { out = await route(req); } catch (e) { out = { code: e.status ?? 502, body: { error: e.message } }; }
    res.writeHead(out.code, { 'content-type': out.type ?? 'application/json' });
    res.end(out.type ? out.body : JSON.stringify(out.body));
  });
}

async function readJson(req) {
  let raw = '';
  for await (const c of req) raw += c;
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}
