/**
 * First-party page-view counter, the same file in every project (projects never share code).
 *
 * Each page view posts the path (plus, once per visit, the referrer and viewport width) to the status project,
 * which stores it with a visitor hash that changes daily. No cookies, no IDs, nothing kept in the browser.
 * The graphs are on https://status.bas-franke.com. Nothing is sent from localhost or automated browsers, and the
 * collector ignores requests whose Origin is not one of our sites, so local builds can never pollute the numbers.
 */
const COLLECTOR = 'https://status.bas-franke.com/api/page';
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|.*\.(local|localhost))$/;

export function trackPageViews() {
  if (LOCAL.test(location.hostname) || navigator.webdriver) return;

  let last = '';
  let first = true;
  const send = () => {
    const path = location.pathname;
    if (path === last) return;
    last = path;
    const body = JSON.stringify({ p: path, r: first ? document.referrer : undefined, w: window.innerWidth });
    first = false;
    try {
      // sendBeacon survives page unloads and needs no CORS preflight; fetch is the fallback for old browsers.
      if (!navigator.sendBeacon?.(COLLECTOR, new Blob([body], { type: 'text/plain' }))) {
        fetch(COLLECTOR, { method: 'POST', body, mode: 'no-cors', keepalive: true }).catch(() => {});
      }
    } catch {
      // Blocked or offline: analytics must never break the page.
    }
  };

  // Single-page apps navigate with history.pushState; count those as page views too.
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
      original.apply(this, args);
      queueMicrotask(send);
    };
  }
  addEventListener('popstate', send);
  send();
}
