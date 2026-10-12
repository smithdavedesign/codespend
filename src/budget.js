export function monthSpend(days, month) {
  return days.filter((d) => d.date.startsWith(month)).reduce((s, d) => s + d.costUsd, 0);
}

export function evaluateBudget(spend, budget) {
  if (!budget) return { spend, budget: budget ?? null, pct: null, crossed: false };
  return { spend, budget, pct: (spend / budget) * 100, crossed: spend >= budget };
}

// Alert levels, in percent of a project's monthly budget.
export const THRESHOLDS = [50, 80, 100];

// Highest threshold reached, or 0.
export function crossedThreshold(pct) {
  return THRESHOLDS.filter((t) => pct >= t).at(-1) ?? 0;
}

// Stored usage as flat rows, each labelled with its connection's tool and project.
export function usageRows(state) {
  return state.connections.flatMap((c) =>
    Object.entries(state.usage[c.id] ?? {}).map(([date, costUsd]) => ({ date, costUsd, tool: c.tool, project: c.project })));
}

export function sumBy(rows, key) {
  const totals = new Map();
  for (const r of rows) totals.set(r[key], (totals.get(r[key]) ?? 0) + r.costUsd);
  return totals;
}
