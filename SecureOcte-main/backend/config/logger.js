/**
 * config/logger.js
 * ─────────────────────────────────────────────────────────────
 * Structured logger using pino.
 *   dev  → pretty-printed (human readable)
 *   prod → newline-delimited JSON (machine parseable)
 * ─────────────────────────────────────────────────────────────
 */

import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

const logger = pino(
  isDev
    ? {
        level: "debug",
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        },
      }
    : {
        level: "info",
        // JSON to stdout — collected by your log aggregator (Loki, Datadog, etc.)
      }
);

export default logger;
