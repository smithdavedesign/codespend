// Vendor keys and Slack webhooks are encrypted at rest (PRD "secure storage", REVENUE.md "encrypt them at rest").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createStore } from '../src/store.js';
import { fakeKey, fakeSlackHook, tmpFile } from './helpers.js';

function fill(store, apiKey, hook) {
  store.update((s) => {
    s.connections.push({ id: 'c1', tool: 'claude', project: 'p', org: null, apiKey, lastSyncAt: null, lastError: null });
    s.projects.p = { monthlyUsd: 10, email: 'a@b.co', slackWebhookUrl: hook };
  });
}

test('the data file never holds a vendor key or Slack webhook in plain text; a reload decrypts them', () => {
  const file = tmpFile();
  const apiKey = fakeKey('at-rest');
  const hook = fakeSlackHook(3);
  fill(createStore(file), apiKey, hook);
  const raw = readFileSync(file, 'utf8');
  assert.equal(raw.includes(apiKey), false);
  assert.equal(raw.includes(hook), false);
  assert.match(raw, /"apiKey":"enc:v1:/);
  const again = createStore(file).get();
  assert.equal(again.connections[0].apiKey, apiKey);
  assert.equal(again.projects.p.slackWebhookUrl, hook);
  // The generated key lives next to the data file, readable by the owner only.
  const keyFile = join(dirname(file), 'secret.key');
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('an M2 data file with plaintext secrets loads, and is sealed on disk straight away', () => {
  const file = tmpFile();
  const apiKey = fakeKey('m2');
  const hook = fakeSlackHook(4);
  writeFileSync(file, JSON.stringify({
    version: 2,
    connections: [{ id: 'c1', tool: 'openai', project: 'p', org: null, apiKey, lastSyncAt: null, lastError: null }],
    projects: { p: { monthlyUsd: 10, email: 'a@b.co', slackWebhookUrl: hook }, q: { monthlyUsd: 5, email: 'q@b.co', slackWebhookUrl: null } },
    usage: { c1: { '2026-10-01': 2 } },
    alerted: {},
  }));
  const s = createStore(file).get();
  assert.equal(s.connections[0].apiKey, apiKey);
  assert.equal(s.projects.p.slackWebhookUrl, hook);
  assert.equal(s.projects.q.slackWebhookUrl, null);
  assert.deepEqual(s.branches, {});
  const raw = readFileSync(file, 'utf8');
  assert.equal(raw.includes(apiKey), false);
  assert.equal(raw.includes(hook), false);
});

test('a supplied key (CODESPEND_ENCRYPTION_KEY) is used instead of a key file; the wrong key is refused clearly', () => {
  const file = tmpFile();
  const key = randomBytes(32).toString('base64');
  fill(createStore(file, { key }), fakeKey('env'), null);
  assert.equal(existsSync(join(dirname(file), 'secret.key')), false);
  assert.equal(createStore(file, { key }).get().connections[0].apiKey, fakeKey('env'));
  assert.throws(() => createStore(file, { key: randomBytes(32).toString('base64') }), /encryption key/i);
  // Without the supplied key, a freshly generated key file can't open it either.
  assert.throws(() => createStore(file), /encryption key/i);
});

test('a malformed encryption key is refused before anything is written', () => {
  const file = tmpFile();
  assert.throws(() => createStore(file, { key: 'too-short' }), /32 bytes/);
  assert.throws(() => createStore(file, { key: randomBytes(16).toString('base64') }), /32 bytes/);
  assert.equal(existsSync(file), false);
});
