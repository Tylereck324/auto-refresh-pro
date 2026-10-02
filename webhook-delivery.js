// webhook-delivery.js — reliable POST of one webhook payload, with retry.
//
// fetch() only rejects on network failure: a Discord 429 (rate limited — the
// exact moment a burst of new studies arrives) or a 5xx resolves normally, and
// treating that as success silently drops the alert. deliver() inspects the
// status and:
//   • 2xx                 → done
//   • 429                 → wait Retry-After (header, or Discord's JSON
//                           retry_after), capped, then retry
//   • 5xx / network error → short backoff, then retry
//   • any other status    → give up at once (bad/deleted webhook; retrying
//                           can't help) and report it
//
// Every wait is capped so the MV3 worker isn't held idle for long (an idle
// worker is killed after ~30s; a pending fetch keeps it alive, a timer doesn't).
//
// Chrome-free and dependency-injected (fetchFn, sleep) so the Node suite can
// drive it deterministically. Loaded two ways:
//   • service worker:   importScripts('webhook-delivery.js') → globalThis.ARPWebhook
//   • Node test runner: require('./webhook-delivery.js')       → module.exports
(function (/** @type {any} */ root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ARPWebhook = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_ATTEMPTS = 3;
  const TIMEOUT_MS = 8000;
  const MAX_WAIT_MS = 10000;          // cap on any single retry wait
  const BACKOFF_MS = [1000, 3000];    // waits before attempts 2 and 3 on 5xx/network

  // Retry-After as ms: a header in (possibly fractional) seconds, else Discord's
  // JSON body field retry_after (seconds). null when neither is usable.
  function retryAfterMs(headerValue, bodyText) {
    const h = parseFloat(headerValue);
    if (Number.isFinite(h) && h >= 0) return Math.round(h * 1000);
    if (typeof bodyText === 'string' && bodyText) {
      try {
        const v = JSON.parse(bodyText).retry_after;
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v * 1000);
      } catch (e) { /* not JSON */ }
    }
    return null;
  }

  // How long to wait before the next attempt, or null to stop retrying.
  // `attempt` is the 1-based attempt that just failed; status 0 = network error.
  function nextDelay(status, attempt, retryAfter) {
    if (attempt >= MAX_ATTEMPTS) return null;
    const backoff = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
    if (status === 429) return Math.min(retryAfter == null ? backoff : retryAfter, MAX_WAIT_MS);
    if (status === 0 || status >= 500) return backoff;
    return null;
  }

  const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // POST `body` (an object, sent as JSON) to `url`. Never throws; resolves to
  //   { ok: true,  status, attempts }
  //   { ok: false, status, attempts, error }   status 0 = network/timeout
  async function deliver(url, body, opts) {
    opts = opts || {};
    const fetchFn = opts.fetchFn || fetch;
    const sleep = opts.sleep || defaultSleep;
    const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
    const payload = JSON.stringify(body);
    let last = { ok: false, status: 0, attempts: 0, error: 'not sent' };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let status = 0;
      let retryAfter = null;
      try {
        const res = await fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          signal: controller.signal,
          // SSRF defense: refuse redirects. The URL guard only vets the INITIAL
          // URL — without this a public endpoint could 30x-redirect the POST to
          // http://169.254.169.254/… and fetch would transparently re-send the
          // body to the internal target. Real webhooks never redirect.
          redirect: 'error',
        });
        status = Number(res && res.status) || 0;
        if (res && res.ok) return { ok: true, status, attempts: attempt };
        if (status === 429) {
          let text = '';
          try { text = await res.text(); } catch (e) { /* ignore */ }
          const header = res.headers && typeof res.headers.get === 'function'
            ? res.headers.get('Retry-After') : null;
          retryAfter = retryAfterMs(header, text);
        }
        last = { ok: false, status, attempts: attempt, error: 'HTTP ' + status };
      } catch (e) {
        last = {
          ok: false, status: 0, attempts: attempt,
          error: (e && e.name === 'AbortError') ? 'timed out' : 'network error',
        };
      } finally {
        clearTimeout(timer);
      }
      const delay = nextDelay(status, attempt, retryAfter);
      if (delay == null) break;
      await sleep(delay);
    }
    return last;
  }

  return { MAX_ATTEMPTS, MAX_WAIT_MS, retryAfterMs, nextDelay, deliver };
});
