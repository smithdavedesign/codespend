// Fake Anthropic cost_report: two days of known usage (amounts in cents, as strings).
export const KNOWN = {
  data: [
    { starting_at: '2026-10-01T00:00:00Z', results: [{ amount: '4000.00', currency: 'USD' }, { amount: '1000.00', currency: 'USD' }] },
    { starting_at: '2026-10-02T00:00:00Z', results: [{ amount: '2500.00', currency: 'USD' }] },
  ],
  has_more: false,
};
export function fakeFetch(body = KNOWN, status = 200) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return { ok: status < 400, status, json: async () => body };
  };
  f.calls = calls;
  return f;
}
export function fakeMailer() {
  const sent = [];
  return { sent, send: async (m) => { sent.push(m); } };
}
