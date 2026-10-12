import { createApp } from './app.js';
import { createStore } from './store.js';
import { createMailer } from './mailer.js';
import { mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });
const port = Number(process.env.PORT) || 3000;
createApp({
  store: createStore(process.env.DB_FILE || 'data/db.json'),
  mailer: createMailer({ sendgridKey: process.env.SENDGRID_API_KEY, from: process.env.ALERT_FROM }),
}).listen(port, '127.0.0.1', () => console.log(`CodeSpend on http://127.0.0.1:${port}`));
