// Tiny JSON-file store (replaces Postgres to stay $0 and dependency-free).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = { apiKey: null, budget: null, days: {}, alerted: {} };

export function createStore(file) {
  let state = existsSync(file) ? { ...EMPTY, ...JSON.parse(readFileSync(file, 'utf8')) } : structuredClone(EMPTY);
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  };
  return {
    get: () => state,
    update(fn) { fn(state); save(); },
    days: () => Object.entries(state.days).map(([date, costUsd]) => ({ date, costUsd })).sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}
