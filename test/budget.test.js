import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthSpend, evaluateBudget } from '../src/budget.js';

const days = [
  { date: '2026-09-30', costUsd: 999 },
  { date: '2026-10-01', costUsd: 50 },
  { date: '2026-10-02', costUsd: 25 },
];

// Exit criterion part 2: the system evaluates the budget.
test('monthSpend sums only the given calendar month', () => {
  assert.equal(monthSpend(days, '2026-10'), 75);
});
test('under budget does not cross', () => {
  assert.deepEqual(evaluateBudget(75, 100), { spend: 75, budget: 100, pct: 75, crossed: false });
});
test('at or over budget crosses 100%', () => {
  assert.equal(evaluateBudget(100, 100).crossed, true);
  assert.equal(evaluateBudget(120, 100).crossed, true);
});
test('no budget set never crosses', () => {
  assert.equal(evaluateBudget(500, null).crossed, false);
});
