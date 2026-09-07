/**
 * ecosystem.config.cjs  (PHASE 3 — ENTERPRISE)
 * ─────────────────────────────────────────────────────────────
 * PM2 cluster configuration.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 reload ecosystem.config.cjs --update-env
 *
 * Notes:
 *   • instances: "max"  → one process per CPU core
 *   • exec_mode: "cluster" → shared port, built-in load balancing
 *   • The distributed Redis rate-limiter in distributedRateLimit.js
 *     ensures all instances share one counter, preventing bypass
 *     by hitting different workers.
 * ─────────────────────────────────────────────────────────────
 */

module.exports = {
  apps: [
    {
      name:      "safety-backend",
      script:    "server.js",
      instances: "max",
      exec_mode: "cluster",

      /* Node ESM support */
      node_args: "--experimental-specifier-resolution=node",
      interpreter_args: "",

      /* Auto-restart on crash */
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,

      /* Memory guard — restart if process exceeds 512 MB */
      max_memory_restart: "512M",

      /* Environment */
      env: {
        NODE_ENV: "production",
        PORT:     4000,
      },
      env_development: {
        NODE_ENV: "development",
        PORT:     4000,
      },

      /* Logging */
      out_file:   "./logs/out.log",
      error_file: "./logs/error.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      /* Graceful shutdown */
      kill_timeout:       5000,
      listen_timeout:     8000,
      shutdown_with_message: true,
    },
  ],
};
