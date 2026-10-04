/* Problem reporting.
 *
 * Sends what only the browser can see -- uncaught exceptions, and quiet
 * degradations like a pilot voice falling back to the robotic one -- to
 * /api/client-error, which logs it and forwards it to Sentry. Loaded first
 * on every page so it catches errors in everything after it. */
(function (ATC) {
  'use strict';

  const MAX_PER_PAGE = 10;   // a render-loop error would otherwise fire 60 times a second
  const sent = new Set();

  /** Report once per distinct kind+message per page load. Never throws. */
  ATC.report = function (kind, message, detail, level) {
    try {
      const key = kind + '|' + message;
      if (sent.has(key) || sent.size >= MAX_PER_PAGE) return;
      sent.add(key);
      const body = JSON.stringify({
        kind, message: String(message), level: level || 'error',
        detail: Object.assign({ userAgent: navigator.userAgent }, detail || {}),
        page: location.pathname,
      });
      fetch('/api/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body, keepalive: true,
      }).catch(() => {});
    } catch (_) {}
  };

  window.addEventListener('error', e => {
    const err = e.error || {};
    ATC.report('uncaught', e.message || String(err), {
      source: e.filename, line: e.lineno, column: e.colno, stack: err.stack,
    });
  });

  window.addEventListener('unhandledrejection', e => {
    const r = e.reason || {};
    ATC.report('unhandled rejection', (r && r.message) || String(r), {
      name: r.name, stack: r.stack,
    });
  });
})(window.ATC = window.ATC || {});
