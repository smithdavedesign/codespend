export function monthSpend(days, month) {
  return days.filter((d) => d.date.startsWith(month)).reduce((s, d) => s + d.costUsd, 0);
}

export function evaluateBudget(spend, budget) {
  if (!budget) return { spend, budget: budget ?? null, pct: null, crossed: false };
  return { spend, budget, pct: (spend / budget) * 100, crossed: spend >= budget };
}
