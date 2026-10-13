import { createApp } from './app.js';
import { createStore } from './store.js';
import { createMailer } from './mailer.js';
import { isSlackWebhookUrl } from './slack.js';
import { DEFAULT_SYNC_INTERVAL_MS } from './sync.js';
import { siteOrigin, vercelEnv } from './site.js';
import { mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });
const port = Number(process.env.PORT) || 3000;
// Optional fallback Slack webhook for projects without their own. Never logged.
const slackDefault = process.env.SLACK_WEBHOOK_URL || null;
if (slackDefault && !isSlackWebhookUrl(slackDefault)) console.warn('SLACK_WEBHOOK_URL ignored: it must be a https://hooks.slack.com/ webhook URL');
createApp({
  // Stored keys are encrypted with CODESPEND_ENCRYPTION_KEY, or with a generated data/secret.key when it is unset.
  store: createStore(process.env.DB_FILE || 'data/db.json', { key: process.env.CODESPEND_ENCRYPTION_KEY }),
  mailer: createMailer({ sendgridKey: process.env.SENDGRID_API_KEY, from: process.env.ALERT_FROM }),
  defaultSlackWebhookUrl: isSlackWebhookUrl(slackDefault) ? slackDefault : null,
  syncIntervalMs: DEFAULT_SYNC_INTERVAL_MS,
  // Public Stripe links (not secrets): the $9/month payment link and the customer-portal login link.
  billing: { paymentLink: process.env.STRIPE_PAYMENT_LINK, portalLink: process.env.STRIPE_PORTAL_LINK },
  contactEmail: process.env.CONTACT_EMAIL,
  // Canonical and share URLs point at the public site; the RepoHQ beacon stays silent unless this is Vercel production.
  siteUrl: siteOrigin(process.env),
  vercelEnv: vercelEnv(process.env),
}).listen(port, '127.0.0.1', () => console.log(`CodeSpend on http://127.0.0.1:${port} (syncing every ${DEFAULT_SYNC_INTERVAL_MS / 60_000} min)`));
