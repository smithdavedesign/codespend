// Sync every connection, store its daily spend, and alert each project by email and Slack at 50/80/100%
// of its monthly budget. One code path serves both the timer and the "Sync now" button:
//
//   startScheduler (every 4 min) ─┐
//   POST /api/sync ───────────────┴─> run() ─ queued, never concurrent
//        └─ fetch all connections in parallel under one 45 s deadline (one failing doesn't block the rest)
//        └─ store usage[connection][date]
//        └─ per project: month spend vs budget ─> email + Slack, each channel at most once per threshold per month
import { PROVIDERS } from './providers.js';
import { usageRows, sumBy, evaluateBudget, crossedThreshold } from './budget.js';

// Poll often enough that an over-budget alert goes out within 5 minutes of the vendor reporting the usage:
// worst case is one interval plus the vendor deadline (4 min + 45 s) plus the send itself.
export const DEFAULT_SYNC_INTERVAL_MS = 4 * 60_000;
// One deadline for all vendor calls in a sync, so a slow or hung vendor can't hold back other projects' alerts.
const VENDOR_DEADLINE_MS = 45_000;
const MAX_ERROR_LENGTH = 200;
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isoDate = (t) => new Date(t).toISOString().slice(0, 10);
const usd = (n) => `$${n.toFixed(2)}`;
const errorText = (e) => String(e?.message ?? e).slice(0, MAX_ERROR_LENGTH);

export function createSyncer({ store, mailer, slack, fetch = globalThis.fetch, now = () => new Date(), defaultSlackWebhookUrl = null, vendorDeadlineMs = VENDOR_DEADLINE_MS }) {
  let queue = Promise.resolve();

  // Queued so the timer and the button can't both see "not alerted yet" and send twice.
  function run() {
    const next = queue.then(syncOnce);
    queue = next.catch(() => {});
    return next;
  }

  async function syncOnce() {
    const t = now();
    const month = t.toISOString().slice(0, 7);
    const monthStart = `${month}-01`;
    const end = isoDate(Date.parse(isoDate(t)) + DAY_MS); // exclusive: tomorrow, so today's spend counts
    const conns = store.get().connections.map((c) => ({ ...c }));
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error(`vendor timeout after ${vendorDeadlineMs / 1000}s`)), vendorDeadlineMs);
    const timedFetch = (url, opts = {}) => fetch(url, { ...opts, signal: deadline.signal });
    const results = await Promise.allSettled(conns.map(async (c) => {
      // Re-read from the day before the last good sync (vendors post usage late), not the whole month.
      const since = c.lastSyncAt ? isoDate(Date.parse(c.lastSyncAt) - DAY_MS) : monthStart;
      return PROVIDERS[c.tool].fetchUsage({ apiKey: c.apiKey, org: c.org, fetch: timedFetch, start: since > monthStart ? since : monthStart, end });
    }));
    clearTimeout(timer);

    const errors = [];
    store.update((s) => {
      results.forEach((r, i) => {
        const c = s.connections.find((x) => x.id === conns[i].id);
        if (!c || c.apiKey !== conns[i].apiKey) return; // revoked or re-keyed mid-sync: drop this result
        if (r.status === 'rejected') {
          c.lastError = errorText(r.reason);
          errors.push({ connectionId: c.id, tool: c.tool, error: c.lastError });
          return;
        }
        const usage = (s.usage[c.id] ??= {});
        for (const d of Array.isArray(r.value) ? r.value : []) {
          if (DATE.test(d?.date) && Number.isFinite(d.costUsd) && d.costUsd >= 0) usage[d.date] = d.costUsd;
        }
        c.lastSyncAt = t.toISOString();
        c.lastError = null;
      });
    });
    return { ...(await sendAlerts(month)), errors };
  }

  async function sendAlerts(month) {
    const s = store.get();
    const rows = usageRows(s).filter((r) => r.date.startsWith(month));
    const spend = sumBy(rows, 'project');
    const sent = [];
    const failed = [];
    for (const [project, p] of Object.entries(s.projects)) {
      const status = evaluateBudget(spend.get(project) ?? 0, p.monthlyUsd);
      const level = crossedThreshold(status.pct);
      if (!level) continue;
      const msg = alertMessage(project, month, level, status, rows.filter((r) => r.project === project));
      const hook = p.slackWebhookUrl || defaultSlackWebhookUrl;
      const channels = {
        email: p.email && (() => mailer.send({ to: p.email, subject: msg.subject, text: msg.text })),
        slack: hook && (() => slack.send({ webhookUrl: hook, text: msg.slack })),
      };
      // Tracked per channel: a failed channel retries next sync, a delivered one never repeats.
      for (const [channel, send] of Object.entries(channels)) {
        const key = `${month}|${project}|${channel}`;
        if (!send || (s.alerted[key] ?? 0) >= level) continue;
        try {
          await send();
          // If the budget was changed during the send, that change re-armed alerts: don't record this one
          // against the new budget, or its own threshold alerts would be suppressed for the rest of the month.
          store.update((x) => { if (x.projects[project] === p) x.alerted[key] = level; });
          sent.push({ project, threshold: level, channel });
        } catch (e) {
          failed.push({ project, channel, error: errorText(e) });
        }
      }
    }
    return { sent, failed };
  }

  return { run, idle: () => queue };
}

function alertMessage(project, month, level, { spend, budget, pct }, rows) {
  const byTool = [...sumBy(rows, 'tool')].map(([tool, v]) => `${PROVIDERS[tool]?.label ?? tool} ${usd(v)}`).join(', ');
  const line = `${project} has spent ${usd(spend)} in ${month}, ${Math.round(pct)}% of its ${usd(budget)} monthly budget (${byTool}).`;
  return {
    subject: `CodeSpend: ${project} reached ${level}% of its ${usd(budget)} budget`,
    text: line,
    slack: `:rotating_light: CodeSpend: *${project}* reached ${level}% of its budget. ${line}`,
  };
}

// Sync now, then every intervalMs. A tick that lands while a sync is still running is skipped.
export function startScheduler(run, intervalMs = DEFAULT_SYNC_INTERVAL_MS, log = console.error) {
  let busy = null;
  const tick = () => {
    if (busy) return;
    busy = new Promise((resolve) => resolve(run()))
      .catch((e) => log(`sync failed: ${errorText(e)}`))
      .finally(() => { busy = null; });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), idle: () => busy ?? Promise.resolve() };
}
