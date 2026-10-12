// Tiny JSON-file store (replaces Postgres to stay $0 and dependency-free).
// Vendor keys and Slack webhooks are encrypted at rest with AES-256-GCM: in memory they are plain, on disk they are
// "enc:v1:<base64 iv|tag|ciphertext>". The file is written 0600 and never sent to the browser.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { usageRows, sumBy } from './budget.js';

export const DEFAULT_PROJECT = 'default';

// connections: [{id, tool, project, org, apiKey, lastSyncAt, lastError}]
// projects:    {name: {monthlyUsd, email, slackWebhookUrl}}
// usage:       {connectionId: {date: costUsd}}
// alerted:     {"month|project|channel": highest threshold delivered}
// branches:    {project: {source: {reportedAt, days: {date: [{branch, costUsd, tokens, commits}]}}}}  (see branches.js)
const EMPTY = { version: 3, connections: [], projects: {}, usage: {}, alerted: {}, branches: {} };
const SEALED = 'enc:v1:';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// key: 32 bytes, base64 (CODESPEND_ENCRYPTION_KEY). Without one, a key file is generated next to the data file.
export function createStore(file, { key } = {}) {
  const secret = key === undefined || key === null || key === '' ? keyFile(join(dirname(file), 'secret.key')) : parseKey(key);
  let state = structuredClone(EMPTY);
  let plaintextFound = false;
  if (existsSync(file)) {
    state = migrate(JSON.parse(readFileSync(file, 'utf8')));
    plaintextFound = forEachSecret(state, (v) => {
      if (!v.startsWith(SEALED)) return v;
      return open(secret, v, file);
    });
  }
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    const sealed = structuredClone(state);
    forEachSecret(sealed, (v) => seal(secret, v));
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(sealed), { mode: 0o600 });
    renameSync(tmp, file); // atomic: a crash mid-write leaves the previous file intact
  };
  // A file from before encryption (M1/M2): seal its secrets on disk now, not at the next change.
  if (plaintextFound) save();
  return {
    get: () => state,
    update(fn) { fn(state); save(); },
    // All tools combined, per day (the M1 shape).
    days: () => [...sumBy(usageRows(state), 'date')].map(([date, costUsd]) => ({ date, costUsd })).sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

// Rewrites every stored secret with fn; returns true if any was not sealed yet.
function forEachSecret(s, fn) {
  let plain = false;
  const visit = (obj, field) => {
    const v = obj[field];
    if (typeof v !== 'string' || !v) return;
    if (!v.startsWith(SEALED)) plain = true;
    obj[field] = fn(v);
  };
  for (const c of s.connections) visit(c, 'apiKey');
  for (const p of Object.values(s.projects)) visit(p, 'slackWebhookUrl');
  return plain;
}

function parseKey(key) {
  const buf = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'base64');
  if (buf.length !== KEY_BYTES) throw new Error('CODESPEND_ENCRYPTION_KEY must be 32 bytes, base64-encoded (e.g. openssl rand -base64 32)');
  return buf;
}

function keyFile(path) {
  if (existsSync(path)) return parseKey(readFileSync(path, 'utf8').trim());
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(path, key.toString('base64'), { mode: 0o600, flag: 'wx' });
  return key;
}

function seal(key, text) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return SEALED + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function open(key, value, file) {
  try {
    const raw = Buffer.from(value.slice(SEALED.length), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(`Cannot decrypt the keys stored in ${file}: the encryption key is not the one they were saved with. `
      + 'Restore CODESPEND_ENCRYPTION_KEY or the secret.key file next to the data file.');
  }
}

// M1 stored one Claude key, one budget and Claude-only days: carry them into the default project.
// M2 (version 2) had no branches and plaintext secrets: both are fixed on load.
function migrate(s) {
  if (s.version >= 2) return { ...structuredClone(EMPTY), ...s, version: EMPTY.version };
  const out = structuredClone(EMPTY);
  if (s.apiKey) {
    out.connections.push({ id: 'claude-default', tool: 'claude', project: DEFAULT_PROJECT, org: null, apiKey: s.apiKey, lastSyncAt: null, lastError: null });
    out.usage['claude-default'] = s.days ?? {};
  }
  if (s.budget) out.projects[DEFAULT_PROJECT] = { monthlyUsd: s.budget.monthlyUsd, email: s.budget.email, slackWebhookUrl: null };
  for (const [month, sent] of Object.entries(s.alerted ?? {})) if (sent) out.alerted[`${month}|${DEFAULT_PROJECT}|email`] = 100;
  return out;
}
