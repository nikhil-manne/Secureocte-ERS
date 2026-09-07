/**
 * middlewares/userAuth.js  (HARDENED)
 * H4 — Standardized errors: { "error": "Unauthorized" }
 */
import jwt    from "jsonwebtoken";
import logger from "../config/logger.js";

export default function userAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== "user") {
      return res.status(403).json({ error: "Unauthorized" });
    }

    req.user = decoded;
    next();
  } catch (err) {
    logger.warn({ msg: "[userAuth] JWT verify failed", name: err.name, ip: req.ip });
    return res.status(401).json({ error: "Unauthorized" });
  }
}
