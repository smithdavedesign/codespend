import { appendFileSync } from 'node:fs';

// Default: append to a local outbox file ($0). SendGrid is used only if a key is supplied.
export function createMailer({ sendgridKey, from, outbox = 'data/outbox.jsonl', fetch = globalThis.fetch } = {}) {
  if (sendgridKey) {
    return {
      async send({ to, subject, text }) {
        const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: { authorization: `Bearer ${sendgridKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: to }] }],
            from: { email: from },
            subject,
            content: [{ type: 'text/plain', value: text }],
          }),
        });
        if (!res.ok) throw new Error(`SendGrid error: ${res.status}`);
      },
    };
  }
  return {
    async send(msg) {
      appendFileSync(outbox, JSON.stringify({ ...msg, at: new Date().toISOString() }) + '\n');
    },
  };
}
