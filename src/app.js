import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PROVIDERS } from './providers.js';
import { evaluateBudget, crossedThreshold, usageRows, sumBy } from './budget.js';
import { DEFAULT_PROJECT } from './store.js';
import { createSyncer, startScheduler } from './sync.js';
import { createSlack, isSlackWebhookUrl } from './slack.js';
import { validateReport, saveReport, summarize, branchRows, isDate, RESERVED } from './branches.js';

const PUBLIC = new URL('../public/', import.meta.url);
const PROJECT = /^[\w.\-/ ]{1,64}$/; // a repo name ("acme/web") or a custom tag
const GITHUB_ORG = /^[A-Za-z0-9-]{1,39}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024; // a branch report: up to 5,000 rows
const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;
export const PRICE_USD = 9; // REVENUE.md: $9/month per workspace

const ok = (body = { ok: true }, code = 200) => ({ code, body });
const fail = (code, error) => ({ code, body: { error } });
const notFound = () => fail(404, 'not found');
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const round6 = (n) => Math.round(n * 1e6) / 1e6;

// Missing or blank → the default project; otherwise a validated label, or null if invalid.
function parseProject(v) {
  if (v === undefined || v === null || v === '') return DEFAULT_PROJECT;
  if (typeof v !== 'string') return null;
  const p = v.trim();
  return PROJECT.test(p) && !RESERVED.has(p) ? p : null;
}
const PROJECT_ERROR = 'project must be 1-64 letters, digits, spaces or . _ - /';
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

// Inclusive UTC dates; the default is the calendar month of `now`.
function parseRange(params, now) {
  const month = now.toISOString().slice(0, 7);
  const monthEnd = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const from = params.get('from') || `${month}-01`;
  const to = params.get('to') || monthEnd;
  if (!isDate(from) || !isDate(to)) return { error: 'from and to must be real dates (YYYY-MM-DD)' };
  if (from > to) return { error: 'from must not be after to' };
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > MAX_RANGE_DAYS) return { error: `the date range can be at most ${MAX_RANGE_DAYS} days` };
  return { from, to };
}

// Stripe Checkout payment links and customer-portal links only: anything else is dropped, never rendered.
function stripeLink(v, host) {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname === host && !u.port && !u.username && !u.password && u.pathname.length > 1 ? u.href : null;
  } catch {
    return null;
  }
}

// RFC 4180 cells. A cell starting with = + - @ (or a tab/CR) is prefixed with ' so a spreadsheet won't run it as a formula.
function csvCell(v) {
  let s = typeof v === 'number' ? String(round6(v)) : String(v ?? '');
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const download = (name, body) => ({ code: 200, type: 'text/csv; charset=utf-8', headers: { 'content-disposition': `attachment; filename="${name}"` }, body });

export function createApp({ store, mailer, slack, fetch = globalThis.fetch, now = () => new Date(), defaultSlackWebhookUrl = null, syncIntervalMs = 0, billing = {}, contactEmail = null }) {
  const syncer = createSyncer({ store, mailer, slack: slack ?? createSlack({ fetch }), fetch, now, defaultSlackWebhookUrl });
  const month = () => now().toISOString().slice(0, 7);
  const monthRows = () => usageRows(store.get()).filter((r) => r.date.startsWith(month()));
  const projectStatus = (name) => evaluateBudget(sumBy(monthRows(), 'project').get(name) ?? 0, store.get().projects[name]?.monthlyUsd);
  const duplicateOf = (tool, org, apiKey) => store.get().connections.find((c) => c.tool === tool && (c.org ?? null) === org && c.apiKey === apiKey);
  const links = {
    priceUsd: PRICE_USD,
    paymentLink: stripeLink(billing.paymentLink, 'buy.stripe.com'),
    portalLink: stripeLink(billing.portalLink, 'billing.stripe.com'),
  };
  const contactHtml = typeof contactEmail === 'string' && EMAIL.test(contactEmail)
    ? `<a href="mailto:${escapeHtml(contactEmail)}">${escapeHtml(contactEmail)}</a>`
    : 'the person who runs this CodeSpend server';

  // Budgets and the projects table are month-to-date; the tool totals and charts follow the chosen range.
  function dashboard({ from, to }) {
    const s = store.get();
    const rows = monthRows();
    const inRange = usageRows(s).filter((r) => r.date >= from && r.date <= to);
    const byProject = sumBy(rows, 'project');
    const tools = Object.entries(PROVIDERS).map(([tool, p]) => {
      const mine = inRange.filter((r) => r.tool === tool);
      const days = [...sumBy(mine, 'date')].map(([date, costUsd]) => ({ date, costUsd })).sort((a, b) => (a.date < b.date ? -1 : 1));
      return {
        tool,
        label: p.label,
        needsOrg: !!p.needsOrg,
        connected: s.connections.some((c) => c.tool === tool),
        monthUsd: rows.filter((r) => r.tool === tool).reduce((a, r) => a + r.costUsd, 0),
        rangeUsd: mine.reduce((a, r) => a + r.costUsd, 0),
        days,
      };
    });
    const names = [...new Set([...s.connections.map((c) => c.project), ...Object.keys(s.projects)])].sort();
    const projects = names.map((name) => {
      const p = s.projects[name];
      const st = evaluateBudget(byProject.get(name) ?? 0, p?.monthlyUsd);
      return { name, ...st, threshold: crossedThreshold(st.pct), email: p?.email ?? null, hasSlack: !!(p?.slackWebhookUrl || defaultSlackWebhookUrl) };
    });
    const def = s.projects[DEFAULT_PROJECT];
    return {
      month: month(),
      totalUsd: rows.reduce((a, r) => a + r.costUsd, 0),
      range: { from, to, totalUsd: inRange.reduce((a, r) => a + r.costUsd, 0) },
      tools,
      projects,
      // Allowlisted fields only: the stored apiKey never leaves the server.
      connections: s.connections.map(({ id, tool, project, org, lastSyncAt, lastError }) => ({ id, tool, project, org: org ?? null, lastSyncAt, lastError })),
      onboarding: {
        connected: s.connections.length > 0,
        budgeted: Object.values(s.projects).some((p) => p.monthlyUsd > 0),
        synced: s.connections.some((c) => c.lastSyncAt),
        branches: Object.values(s.branches).some((sources) => Object.keys(sources).length > 0),
      },
      billing: links,
      // M1 fields: all-time daily totals, and the default project's status and budget.
      days: store.days(),
      status: projectStatus(DEFAULT_PROJECT),
      hasKey: s.connections.length > 0,
      budget: def ? { monthlyUsd: def.monthlyUsd, email: def.email } : null,
    };
  }

  function usageCsv({ from, to }) {
    const sums = new Map();
    for (const r of usageRows(store.get())) {
      if (r.date < from || r.date > to) continue;
      const key = `${r.date}\n${r.tool}\n${r.project}`;
      sums.set(key, (sums.get(key) ?? 0) + r.costUsd);
    }
    const rows = [...sums].map(([key, usd]) => [...key.split('\n'), usd]).sort((a, b) => (a.slice(0, 3).join('\n') < b.slice(0, 3).join('\n') ? -1 : 1));
    return download(`codespend-usage-${from}-to-${to}.csv`, csv(['date', 'tool', 'project', 'cost_usd'], rows));
  }

  function branchesCsv(project, range) {
    const rows = branchRows(store.get(), project, range).map((r) => [r.date, r.project, r.branch, r.costUsd, r.tokens, r.commits]);
    return download(`codespend-branches-${range.from}-to-${range.to}.csv`, csv(['date', 'project', 'branch', 'cost_usd', 'tokens', 'commits'], rows));
  }

  function saveBranches(input) {
    const project = parseProject(input.project);
    if (!project) return fail(400, PROJECT_ERROR);
    const report = validateReport(input);
    if (report.error) return fail(400, report.error);
    store.update((s) => saveReport(s, project, report, now().toISOString()));
    return ok({ ok: true, project, rows: report.rows.length });
  }

  function deleteBranches(raw) {
    if (!raw) return fail(400, 'project required');
    const project = parseProject(raw);
    if (!project) return fail(400, PROJECT_ERROR);
    if (!Object.hasOwn(store.get().branches, project)) return notFound();
    store.update((s) => { delete s.branches[project]; });
    return ok();
  }

  const page = (name) => ({ code: 200, type: 'text/html; charset=utf-8', body: readFileSync(new URL(name, PUBLIC), 'utf8').replaceAll('<!--CONTACT-->', () => contactHtml) });

  async function sync() {
    if (!store.get().connections.length) return fail(400, 'Add a connection first');
    const r = await syncer.run();
    return ok({ alerted: r.sent.length > 0, sent: r.sent, failed: r.failed, errors: r.errors, status: projectStatus(DEFAULT_PROJECT) });
  }

  function addConnection(input) {
    const { tool } = input;
    if (typeof tool !== 'string' || !Object.hasOwn(PROVIDERS, tool)) return fail(400, `tool must be one of: ${Object.keys(PROVIDERS).join(', ')}`);
    if (!nonEmpty(input.apiKey)) return fail(400, 'apiKey required');
    const project = parseProject(input.project);
    if (!project) return fail(400, PROJECT_ERROR);
    const org = PROVIDERS[tool].needsOrg ? String(input.org ?? '').trim() : null;
    if (org !== null && !GITHUB_ORG.test(org)) return fail(400, 'org required: the GitHub organization login');
    const apiKey = input.apiKey.trim();
    const dup = duplicateOf(tool, org, apiKey);
    if (dup) return fail(409, `This key is already connected to project "${dup.project}"`);
    const id = randomUUID();
    store.update((s) => { s.connections.push({ id, tool, project, org, apiKey, lastSyncAt: null, lastError: null }); });
    return ok({ id }, 201);
  }

  function relabel(id, input) {
    const project = parseProject(input.project);
    if (!project) return fail(400, PROJECT_ERROR);
    if (!store.get().connections.some((c) => c.id === id)) return notFound();
    store.update((s) => { s.connections.find((c) => c.id === id).project = project; });
    return ok();
  }

  // Revoke: forget the key and everything synced with it.
  function removeConnection(id) {
    if (!store.get().connections.some((c) => c.id === id)) return notFound();
    store.update((s) => {
      s.connections = s.connections.filter((c) => c.id !== id);
      delete s.usage[id];
    });
    return ok();
  }

  // M1 route: one Claude admin key for the default project.
  function saveClaudeKey(input) {
    if (!nonEmpty(input.apiKey)) return fail(400, 'apiKey required');
    const apiKey = input.apiKey.trim();
    const existing = store.get().connections.find((c) => c.tool === 'claude' && c.project === DEFAULT_PROJECT);
    const dup = duplicateOf('claude', null, apiKey);
    if (dup && dup !== existing) return fail(409, `This key is already connected to project "${dup.project}"`);
    store.update((s) => {
      const c = s.connections.find((x) => x.id === existing?.id);
      if (c) Object.assign(c, { apiKey, lastSyncAt: null, lastError: null });
      else s.connections.push({ id: randomUUID(), tool: 'claude', project: DEFAULT_PROJECT, org: null, apiKey, lastSyncAt: null, lastError: null });
    });
    return ok();
  }

  function saveBudget(input) {
    const project = parseProject(input.project);
    if (!project) return fail(400, PROJECT_ERROR);
    const { monthlyUsd, email } = input;
    if (!(typeof monthlyUsd === 'number' && Number.isFinite(monthlyUsd) && monthlyUsd > 0)) return fail(400, 'monthlyUsd must be > 0');
    if (typeof email !== 'string' || !EMAIL.test(email)) return fail(400, 'valid email required');
    const hook = typeof input.slackWebhookUrl === 'string' ? input.slackWebhookUrl.trim() : input.slackWebhookUrl;
    if (hook !== undefined && hook !== null && hook !== '' && !isSlackWebhookUrl(hook)) return fail(400, 'slackWebhookUrl must be a https://hooks.slack.com/ webhook URL');
    store.update((s) => {
      // Omitted → keep the stored webhook (the page never sees it, so can't resend it); '' or null → remove it.
      const slackWebhookUrl = hook === undefined ? s.projects[project]?.slackWebhookUrl ?? null : hook || null;
      s.projects[project] = { monthlyUsd, email, slackWebhookUrl };
      // A new budget re-arms this project's alerts.
      for (const key of Object.keys(s.alerted)) if (key.split('|')[1] === project) delete s.alerted[key];
    });
    return ok();
  }

  function getRoute(pathname, params) {
    if (pathname === '/') return page('index.html');
    if (pathname === '/privacy') return page('privacy.html');
    if (pathname === '/terms') return page('terms.html');
    if (!['/api/usage', '/api/usage.csv', '/api/branches', '/api/branches.csv'].includes(pathname)) return notFound();
    const range = parseRange(params, now());
    if (range.error) return fail(400, range.error);
    if (pathname === '/api/usage') return ok(dashboard(range));
    if (pathname === '/api/usage.csv') return usageCsv(range);
    // Branch views: no project → the first project with data (view) or every project (CSV).
    const raw = params.get('project');
    const project = raw ? parseProject(raw) : null;
    if (raw && !project) return fail(400, PROJECT_ERROR);
    return pathname === '/api/branches' ? ok(summarize(store.get(), project, range)) : branchesCsv(project, range);
  }

  async function route(req) {
    const { method } = req;
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    if (method === 'GET') return getRoute(pathname, searchParams);
    if (!['POST', 'PATCH', 'DELETE'].includes(method)) return notFound();
    // Mutations must be JSON: a cross-site form or text/plain POST can't set this without a CORS preflight, which is never granted.
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return fail(415, 'content-type must be application/json');
    if (method === 'POST' && pathname === '/api/sync') return sync();
    const input = await readJson(req, pathname === '/api/branches' ? MAX_REPORT_BYTES : MAX_BODY_BYTES);
    if (method === 'POST' && pathname === '/api/connections') return addConnection(input);
    if (method === 'POST' && pathname === '/api/key') return saveClaudeKey(input);
    if (method === 'POST' && pathname === '/api/budget') return saveBudget(input);
    if (method === 'POST' && pathname === '/api/branches') return saveBranches(input);
    if (method === 'DELETE' && pathname === '/api/branches') return deleteBranches(searchParams.get('project'));
    const id = pathname.match(/^\/api\/connections\/([\w-]{1,64})$/)?.[1];
    if (id && method === 'PATCH') return relabel(id, input);
    if (id && method === 'DELETE') return removeConnection(id);
    return notFound();
  }

  const server = createServer(async (req, res) => {
    let out;
    try { out = await route(req); } catch (e) { out = { code: e.status ?? 502, body: { error: e.message } }; }
    res.writeHead(out.code, { 'content-type': out.type ?? 'application/json', ...out.headers });
    res.end(out.type ? out.body : JSON.stringify(out.body));
  });
  let scheduler = null;
  if (syncIntervalMs > 0) {
    server.on('listening', () => { scheduler ??= startScheduler(syncer.run, syncIntervalMs); });
    server.on('close', () => { scheduler?.stop(); scheduler = null; });
  }
  // idle() settles once the timer's tick and every queued sync have finished.
  server.syncer = { run: syncer.run, idle: async () => { await scheduler?.idle(); await syncer.idle(); } };
  return server;
}

async function readJson(req, limit = MAX_BODY_BYTES) {
  let raw = '';
  for await (const c of req) {
    raw += c;
    if (raw.length > limit) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  let v;
  try { v = raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw Object.assign(new Error('body must be a JSON object'), { status: 400 });
  return v;
}
