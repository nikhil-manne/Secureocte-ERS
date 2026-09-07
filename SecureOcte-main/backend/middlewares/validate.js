/**
 * middlewares/validate.js
 * ─────────────────────────────────────────────────────────────
 * Factory that wraps a Zod schema into Express middleware.
 *
 * Usage:
 *   import { validate } from "../middlewares/validate.js";
 *   import { panicSchema } from "../middlewares/validationSchemas.js";
 *
 *   router.post("/", verifyToken, validate(panicSchema), handler);
 * ─────────────────────────────────────────────────────────────
 */

import logger from "../config/logger.js";

export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
      }));
      logger.warn({ path: req.path, issues }, "[Validate] Request body invalid");
      return res.status(400).json({ error: "Validation failed", issues });
    }
    req.body = result.data; // replace with parsed + coerced data
    next();
  };
}
