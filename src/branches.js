// Branch reports posted by bin/codespend-branches.mjs, stored per project and per source (one machine + checkout):
//   state.branches[project][source] = { reportedAt, days: { date: [{branch, costUsd, tokens, commits}] } }
// A re-post from a source replaces the days it covers (re-running the CLI never double counts); sources add up.
// Branch rows are a list, not an object keyed by branch name, so no branch name can collide with Object internals.
// This is a breakdown view only: it never feeds budgets or alerts (the vendor connections do).
export const MAX_ROWS = 5000;
const SOURCE = /^[\w-]{1,64}$/;
const BRANCH = /^[^\x00-\x1f\x7f]{1,255}$/;
const MAX_USD = 1e9;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

// A real calendar date: 2026-02-30 is rejected, whether the engine rolls it over or refuses to parse it.
export function isDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().startsWith(v);
}
// Names that are special as plain-object keys.
export const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

// -> {source, rows} or {error}. The project label is validated by the caller (same rule as everywhere else).
export function validateReport(input) {
  const { source, rows } = input;
  if (typeof source !== 'string' || !SOURCE.test(source) || RESERVED.has(source)) return { error: 'source must be 1-64 letters, digits, _ or -' };
  if (!Array.isArray(rows)) return { error: 'rows must be an array' };
  if (rows.length > MAX_ROWS) return { error: `at most ${MAX_ROWS} rows per report` };
  for (const [i, r] of rows.entries()) {
    const bad = (what) => ({ error: `rows[${i}]: ${what}` });
    if (typeof r !== 'object' || r === null) return bad('must be an object');
    if (!isDate(r.date)) return bad('date must be a real YYYY-MM-DD date');
    if (typeof r.branch !== 'string' || !BRANCH.test(r.branch)) return bad('branch must be 1-255 characters, no control characters');
    if (typeof r.costUsd !== 'number' || !Number.isFinite(r.costUsd) || r.costUsd < 0 || r.costUsd > MAX_USD) return bad('costUsd must be a number >= 0');
    if (!isCount(r.tokens)) return bad('tokens must be a whole number >= 0');
    if (!isCount(r.commits)) return bad('commits must be a whole number >= 0');
  }
  return { source, rows };
}

export function saveReport(state, project, { source, rows }, at) {
  const days = {};
  for (const r of rows) {
    const list = (days[r.date] ??= []);
    const same = list.find((x) => x.branch === r.branch);
    if (same) Object.assign(same, { costUsd: round6(same.costUsd + r.costUsd), tokens: same.tokens + r.tokens, commits: same.commits + r.commits });
    else list.push({ branch: r.branch, costUsd: round6(r.costUsd), tokens: r.tokens, commits: r.commits });
  }
  const sources = (state.branches[project] ??= {});
  const prev = sources[source]?.days ?? {};
  sources[source] = { reportedAt: at, days: { ...prev, ...days } };
}

// Flat rows for one project (or all), within [from, to], summed across sources: [{date, project, branch, costUsd, tokens, commits}].
export function branchRows(state, project, { from, to }) {
  const sum = new Map();
  for (const [p, sources] of Object.entries(state.branches)) {
    if (project && p !== project) continue;
    for (const { days } of Object.values(sources)) {
      for (const [date, list] of Object.entries(days)) {
        if (date < from || date > to) continue;
        for (const r of list) {
          const key = `${date}\n${p}\n${r.branch}`;
          const cur = sum.get(key) ?? { date, project: p, branch: r.branch, costUsd: 0, tokens: 0, commits: 0 };
          sum.set(key, { ...cur, costUsd: cur.costUsd + r.costUsd, tokens: cur.tokens + r.tokens, commits: cur.commits + r.commits });
        }
      }
    }
  }
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...sum.values()]
    .map((r) => ({ ...r, costUsd: round6(r.costUsd) }))
    .sort((a, b) => order(a.date, b.date) || order(a.project, b.project) || order(a.branch, b.branch));
}

// The attribution view: per-branch totals, share of spend and daily series, most expensive first.
export function summarize(state, requested, range) {
  const projects = Object.keys(state.branches).filter((p) => Object.keys(state.branches[p]).length).sort();
  const project = requested ?? projects[0] ?? null;
  const rows = project ? branchRows(state, project, range) : [];
  const byBranch = new Map();
  for (const r of rows) {
    const b = byBranch.get(r.branch) ?? { branch: r.branch, costUsd: 0, tokens: 0, commits: 0, days: [] };
    b.costUsd += r.costUsd;
    b.tokens += r.tokens;
    b.commits += r.commits;
    b.days.push({ date: r.date, costUsd: r.costUsd });
    byBranch.set(r.branch, b);
  }
  const totalUsd = round6(rows.reduce((a, r) => a + r.costUsd, 0));
  const branches = [...byBranch.values()]
    .map((b) => ({ ...b, costUsd: round6(b.costUsd), sharePct: totalUsd ? (b.costUsd / totalUsd) * 100 : 0 }))
    .sort((a, b) => b.costUsd - a.costUsd || b.commits - a.commits || (a.branch < b.branch ? -1 : 1));
  const reports = project ? Object.values(state.branches[project] ?? {}).map((s) => s.reportedAt).sort() : [];
  return {
    project,
    projects,
    from: range.from,
    to: range.to,
    totalUsd,
    tokens: rows.reduce((a, r) => a + r.tokens, 0),
    commits: rows.reduce((a, r) => a + r.commits, 0),
    reportedAt: reports.at(-1) ?? null,
    branches,
  };
}
