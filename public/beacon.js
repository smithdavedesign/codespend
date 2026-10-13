// RepoHQ beacon: counts real use of CodeSpend with three anonymous events (listed on /privacy).
//   visit    – once per browser session (sessionStorage), on any page
//   activate – once per browser (localStorage), the first time "Sync now" succeeds in the dashboard
//   checkout – every click on a Get Pro button ([data-buy])
// Each POST carries only {slug, kind, referrer}. The referrer is sent only when it is another site, and the request
// itself sends no referrer and no cookies, so this page's URL never leaves the browser.
// Silent for automated browsers (navigator.webdriver), anywhere but Vercel production (data-env on this script tag)
// and when localStorage "repohq:notrack" is set.
(() => {
  const ENDPOINT = 'https://repohq.vercel.app/api/ideas/signal';
  const SLUG = 'codespend';
  const env = document.currentScript?.dataset.env;
  const ONCE = { visit: () => sessionStorage, activate: () => localStorage };

  function muted() {
    if (navigator.webdriver || env !== 'production') return true;
    try {
      return localStorage.getItem('repohq:notrack') !== null;
    } catch {
      return true; // storage is blocked, so the opt-out can't be read: stay silent
    }
  }

  function referrer() {
    try {
      return document.referrer && new URL(document.referrer).origin !== location.origin ? document.referrer : null;
    } catch {
      return null;
    }
  }

  function signal(kind) {
    if (muted()) return;
    try {
      const store = Object.hasOwn(ONCE, kind) ? ONCE[kind]() : null;
      const key = `repohq:${SLUG}:${kind}`;
      if (store) {
        if (store.getItem(key)) return;
        store.setItem(key, '1');
      }
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: SLUG, kind, referrer: referrer() }),
        keepalive: true,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      }).catch(() => {});
    } catch {
      // Fire and forget: counting must never break the page.
    }
  }

  window.repohq = { signal };
  signal('visit');
  document.addEventListener('click', (e) => {
    if (e.target?.closest?.('[data-buy]')) signal('checkout');
  });
})();
