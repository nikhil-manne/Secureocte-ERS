/**
 * middlewares/securityLogger.js  (NEW — HARDENED)
 * ─────────────────────────────────────────────────────────────
 * H7 — Structured forensic logging for:
 *   • All auth attempts (success + failure)       → logged in auth.js/verifyToken.js
 *   • Panic triggers                              → logged in panicRoutes.js
 *   • Admin actions (login, data access, changes) → logged in panicRoutes.js + auth.js
 *   • Device mismatches                           → logged in verifyToken.js
 *
 * This middleware adds a request-level audit trail that captures
 * every request to sensitive endpoints with a tamper-resistant
 * append-only log entry (via pino — structured JSON).
 *
 * H7 — Log retention: logs must be kept ≥90 days.
 *      Configure log rotation / shipping in your infra (e.g. PM2
 *      log-rotate, CloudWatch, Datadog) with a 90-day retention policy.
 * ─────────────────────────────────────────────────────────────
 */

import logger from "../config/logger.js";

/* Sensitive path prefixes that always get an audit log entry */
const AUDIT_PATHS = [
  "/api/auth",
  "/api/panic",
  "/api/admin",
  "/health",
];

function isAuditPath(path) {
  return AUDIT_PATHS.some((p) => path.startsWith(p));
}

/**
 * auditLogger — records every request to sensitive paths.
 * Output is structured JSON via pino (tamper-resistant when
 * shipped to an append-only log sink like CloudWatch / Loki).
 */
export function auditLogger(req, res, next) {
  if (!isAuditPath(req.path)) return next();

  const startMs = Date.now();

  res.on("finish", () => {
    logger.info({
      audit:    true,               // H7 — tag for log filter/retention policy
      method:   req.method,
      path:     req.path,
      status:   res.statusCode,
      ms:       Date.now() - startMs,
      ip:       req.ip,
      userId:   req.user?.userId   || null,
      role:     req.user?.role     || null,
      deviceId: req.user?.deviceId || req.headers["x-device-id"] || null,
      ua:       req.headers["user-agent"]?.slice(0, 120) || null,
    });
  });

  next();
}

/**
 * adminActionLogger — extra log for mutating admin actions.
 * Wrap around admin-only handlers for H7 admin action audit trail.
 */
export function adminActionLogger(action) {
  return (req, res, next) => {
    if (req.user?.role === "admin") {
      logger.info({
        audit:      true,
        adminAction: action,
        adminUser:  req.user.username,
        ip:         req.ip,
        path:       req.path,
      });
    }
    next();
  };
}
