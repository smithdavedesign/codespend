import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlack, isSlackWebhookUrl } from '../src/slack.js';
import { fakeSlackHook } from './helpers.js';

test('only https://hooks.slack.com webhook URLs are accepted (the server POSTs to them, so anything else is SSRF)', () => {
  const good = fakeSlackHook();
  assert.equal(isSlackWebhookUrl(good), true);
  const path = new URL(good).pathname;
  for (const bad of [
    good.replace('https:', 'http:'),
    `https://hooks.slack.com.evil.example${path}`,
    `https://evil.example/${good}`,
    `https://user:pw@hooks.slack.com${path}`,
    `https://hooks.slack.com:8443${path}`,
    'https://hooks.slack.com/',
    'http://127.0.0.1:3000/api/budget',
    'not a url',
    '',
    null,
    undefined,
    42,
    { href: good },
  ]) assert.equal(isSlackWebhookUrl(bad), false, String(bad));
});

test('send posts the message as JSON {text} to the webhook, with a timeout and no redirects', async () => {
  const calls = [];
  const slack = createSlack({ fetch: async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; } });
  const hook = fakeSlackHook();
  await slack.send({ webhookUrl: hook, text: 'acme reached 100%' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, hook);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { text: 'acme reached 100%' });
  assert.equal(calls[0].opts.redirect, 'error');
  assert.ok(calls[0].opts.signal instanceof AbortSignal);
});

test('send reports a failed webhook with its status', async () => {
  const slack = createSlack({ fetch: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(slack.send({ webhookUrl: fakeSlackHook(), text: 'x' }), /Slack webhook error: 404/);
});

test('send refuses a non-Slack URL without making a request', async () => {
  let called = false;
  const slack = createSlack({ fetch: async () => { called = true; return { ok: true, status: 200 }; } });
  await assert.rejects(slack.send({ webhookUrl: 'http://169.254.169.254/latest', text: 'x' }), /invalid Slack webhook URL/);
  assert.equal(called, false);
});
