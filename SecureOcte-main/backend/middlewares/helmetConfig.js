/**
 * middlewares/helmetConfig.js  (HARDENED)
 * ─────────────────────────────────────────────────────────────
 * H4 — Remove headers that reveal infrastructure:
 *   x-render-origin-server  — removed via custom middleware
 *   X-RateLimit-*           — suppressed in all rate limiters
 *   X-Powered-By            — removed by helmet
 *   Server                  — removed
 * ─────────────────────────────────────────────────────────────
 */

import helmet from "helmet";

/* ── Strip infrastructure-revealing headers on every response ── */
export function stripInfraHeaders(req, res, next) {
  // Run after response headers are set
  const origSetHeader = res.setHeader.bind(res);
  res.setHeader = function (name, value) {
    const lower = name.toLowerCase();
    // H4 — block any header that reveals infra
    if (
      lower === "x-render-origin-server" ||
      lower === "x-powered-by"           ||
      lower === "server"                 ||
      lower.startsWith("x-ratelimit-")
    ) {
      return res; // silently drop
    }
    return origSetHeader(name, value);
  };
  next();
}

/* ── Strict (all protected routes) ── */
export const helmetStrict = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "https://maps.googleapis.com", "https://maps.gstatic.com"],
      styleSrc:    ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:     ["'self'", "https://fonts.gstatic.com"],
      imgSrc:      ["'self'", "data:", "https:", "blob:"],
      connectSrc:  [
        "'self'",
        "https://server-r9k4.onrender.com",
        "https://maps.googleapis.com",
        "https://maps.gstatic.com",
        "https://*.googleapis.com",
      ],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
      workerSrc:   ["blob:"],
    },
  },
  hsts: {
    maxAge:            31_536_000,
    includeSubDomains: true,
    preload:           true,
  },
  frameguard:               { action: "deny" },
  crossOriginEmbedderPolicy: false,
  hidePoweredBy:             true,   // H4 — remove X-Powered-By
  referrerPolicy:            { policy: "no-referrer" },
});

/* ── Stream viewer — permissive CSP (public shared links) ── */
export const helmetStream = helmet({
  contentSecurityPolicy:     false,
  crossOriginEmbedderPolicy: false,
  hidePoweredBy:             true,
});

/* ── Stream CSP middleware (applied AFTER helmetStream) ── */
export function streamCsp(req, res, next) {
  res.setHeader("Content-Security-Policy", [
    "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:",
    "script-src * 'unsafe-inline' 'unsafe-eval' blob:",
    "script-src-attr 'unsafe-inline' 'unsafe-hashes'",
    "style-src * 'unsafe-inline'",
    "img-src * data: blob:",
    "connect-src *",
    "font-src * data:",
    "worker-src blob: *",
  ].join("; "));
  next();
}
