/**
 * middlewares/globalErrorHandler.js  (v3)
 * ─────────────────────────────────────────────────────────────
 * FIX 7 — Standardised error dispatch exactly per spec:
 *
 *   err.type === "validation" → 400
 *   err.type === "auth"       → 401
 *   err.type === "rate"       → 429
 *   default                   → 500
 *
 * Logs: path, user id, full stack.
 * Stack trace never sent to client in production.
 * ─────────────────────────────────────────────────────────────
 */

import logger from "../config/logger.js";

// eslint-disable-next-line no-unused-vars
export default function globalErrorHandler(err, req, res, next) {
  logger.error({
    path:  req.path,
    user:  req.user?.id ?? req.user?.userId,
    stack: err.stack,
    msg:   err.message,
    type:  err.type,
  });

  if (err.type === "validation") {
    return res.status(400).json({ error: err.message || "Validation error" });
  }

  if (err.type === "auth") {
    return res.status(401).json({ error: err.message || "Unauthorized" });
  }

  if (err.type === "rate") {
    return res.status(429).json({ error: err.message || "Too many requests" });
  }

  return res.status(500).json({ error: "Internal server error" });
}
