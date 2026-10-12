import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchClaudeUsage } from '../src/claude.js';
import { fakeFetch } from './helpers.js';

// Exit criterion part 1: known usage from a test key is fetched correctly.
test('fetches daily usage and converts cents to USD', async () => {
  const f = fakeFetch();
  const days = await fetchClaudeUsage({ apiKey: 'sk-ant-admin-test', fetch: f, start: '2026-10-01', end: '2026-10-03' });
  assert.deepEqual(days, [{ date: '2026-10-01', costUsd: 50 }, { date: '2026-10-02', costUsd: 25 }]);
  assert.match(f.calls[0].url, /\/v1\/organizations\/cost_report/);
  assert.equal(f.calls[0].opts.headers['x-api-key'], 'sk-ant-admin-test');
});

test('throws a clear error on a rejected key', async () => {
  await assert.rejects(
    fetchClaudeUsage({ apiKey: 'bad', fetch: fakeFetch({}, 401), start: '2026-10-01', end: '2026-10-02' }),
    /401/,
  );
});
