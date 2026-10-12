import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMailer } from '../src/mailer.js';

test('default mailer writes to a local outbox ($0, no SendGrid)', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cs-')), 'outbox.jsonl');
  await createMailer({ outbox: file }).send({ to: 'a@b.co', subject: 's', text: 't' });
  assert.equal(JSON.parse(readFileSync(file, 'utf8').trim()).to, 'a@b.co');
});

test('SendGrid mailer is used only when a key is supplied, via injected fetch', async () => {
  const calls = [];
  const f = async (u, o) => { calls.push({ u, o }); return { ok: true, status: 202 }; };
  await createMailer({ sendgridKey: 'SG.x', from: 'me@x.co', fetch: f }).send({ to: 'a@b.co', subject: 's', text: 't' });
  assert.equal(calls[0].u, 'https://api.sendgrid.com/v3/mail/send');
  assert.equal(calls[0].o.headers.authorization, 'Bearer SG.x');
});
