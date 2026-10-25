/**
 * First-party page-view counter, the same file in every project (projects never share code).
 *
 * Each page view posts the path, viewport width, the browser's time zone and language (plus, once per visit, the
 * referrer and utm_source/utm_medium) to the status project, which stores it with a visitor hash that changes daily.
 * When the page view ends (route change, tab hidden, page closed) it posts how long the page was visible and in use.
 * The two are matched by a random id that only lives in this page's memory: no cookies, no storage, nothing kept in
 * the browser. The graphs are on https://status.bas-franke.com. Nothing is sent from localhost or automated browsers,
 * and the collector ignores requests whose Origin is not one of our sites, so local builds never pollute the numbers.
 */
const COLLECTOR = 'https://status.bas-franke.com/api/page';
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|.*\.(local|localhost))$/;
// Engaged time stops counting this long after the last input, so a forgotten open tab does not count as reading.
const IDLE_MS = 2 * 60_000;
const MAX_MS = 30 * 60_000;

const randomId = () =>
  globalThis.crypto?.randomUUID?.() ?? Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

function post(data: object) {
  const body = JSON.stringify(data);
  try {
    // sendBeacon survives page unloads and needs no CORS preflight; fetch is the fallback for old browsers.
    if (!navigator.sendBeacon?.(COLLECTOR, new Blob([body], { type: 'text/plain' }))) {
      fetch(COLLECTOR, { method: 'POST', body, mode: 'no-cors', keepalive: true }).catch(() => {});
    }
  } catch {
    // Blocked or offline: analytics must never break the page.
  }
}

export function trackPageViews() {
  if (LOCAL.test(location.hostname) || navigator.webdriver) return;

  let last = '';
  let first = true;

  // Engaged time of the current page view: counted while the tab is visible, the window focused and the last
  // input (pointer, key, scroll, touch) is less than IDLE_MS ago.
  let viewId = '';
  let engaged = 0; // ms counted so far
  let sentMs = 0; // largest value already sent for this view
  let since = 0; // start of the running stretch; 0 = not counting
  let lastInput = Date.now();
  let focused = true;

  const pause = () => {
    if (since) engaged += Math.max(0, Math.min(Date.now(), lastInput + IDLE_MS) - since);
    since = 0;
  };
  const resume = () => {
    if (!since && focused && document.visibilityState === 'visible') since = Date.now();
  };
  const onInput = () => {
    // Back from idle: close the old stretch at the idle cut-off, then start a new one.
    if (Date.now() - lastInput > IDLE_MS) pause();
    lastInput = Date.now();
    resume();
  };
  // Report the engaged time so far; called again later it sends the larger total (the collector keeps the max).
  const flush = () => {
    pause();
    const ms = Math.min(Math.round(engaged), MAX_MS);
    if (viewId && ms > sentMs) {
      sentMs = ms;
      post({ e: 1, v: viewId, ms });
    }
    resume();
  };

  const view = () => {
    const path = location.pathname;
    if (path === last) return;
    if (last) flush(); // the previous page view ends here
    last = path;
    viewId = randomId();
    engaged = sentMs = since = 0;
    lastInput = Date.now();
    resume();

    let tz: string | undefined;
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      // Very old browser: the country shows as unknown.
    }
    const data: Record<string, unknown> = { p: path, v: viewId, w: window.innerWidth, tz, l: navigator.language };
    if (first) {
      const params = new URLSearchParams(location.search);
      data.r = document.referrer;
      data.us = params.get('utm_source') || undefined;
      data.um = params.get('utm_medium') || undefined;
      first = false;
    }
    post(data);
  };

  // Single-page apps navigate with history.pushState; count those as page views too.
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
      original.apply(this, args);
      queueMicrotask(view);
    };
  }
  addEventListener('popstate', view);

  document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? flush() : onInput()));
  addEventListener('pagehide', flush);
  addEventListener('blur', () => {
    focused = false;
    pause();
  });
  addEventListener('focus', () => {
    focused = true;
    onInput();
  });
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'scroll', 'wheel', 'touchstart']) {
    addEventListener(type, onInput, { capture: true, passive: true });
  }
  view();
}
