// Slack alerts via incoming webhooks: free, no Slack app or OAuth needed.
// A webhook URL is a secret: it is stored server-side and never sent back to the page.
const TIMEOUT_MS = 30_000;

// The server POSTs to this user-supplied URL, so anything but Slack's webhook host would be an SSRF hole.
export function isSlackWebhookUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'hooks.slack.com' && !u.port && !u.username && !u.password && u.pathname.length > 1;
  } catch {
    return false;
  }
}

export function createSlack({ fetch = globalThis.fetch } = {}) {
  return {
    async send({ webhookUrl, text }) {
      if (!isSlackWebhookUrl(webhookUrl)) throw new Error('invalid Slack webhook URL');
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Slack webhook error: ${res.status}`);
    },
  };
}
