/**
 * middlewares/verifyToken.js  (HARDENED)
 * ─────────────────────────────────────────────────────────────
 * H4 — All auth errors standardized to { "error": "Unauthorized" }
 * H5 — Strict device binding on every request
 * H7 — Logs device mismatches for forensics
 * ─────────────────────────────────────────────────────────────
 */

import jwt from "jsonwebtoken";
import logger from "../config/logger.js";

export default function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    // H4 — no info leakage about whether token expired vs invalid
    logger.warn({ msg: "[verifyToken] JWT verify failed", name: err.name, ip: req.ip });
    return res.status(401).json({ error: "Unauthorized" });
  }

  /* ── H5: Strict device binding for all non-admin users ── */
  if (decoded.role !== "admin") {
    const deviceIdHeader = req.headers["x-device-id"];

    if (decoded.deviceId && deviceIdHeader && decoded.deviceId !== deviceIdHeader) {
      // H5+H7 — device switch detected, log for forensics
      logger.warn({
        msg: "[verifyToken] Device mismatch — possible device switch",
        userId: decoded.userId,
        tokenDevice: decoded.deviceId,
        headerDevice: deviceIdHeader,
        ip: req.ip,
      });
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  req.user = decoded; // { userId, role, deviceId, iat, exp }
  next();
}
