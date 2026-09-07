/**
 * config/redisCluster.js
 * ─────────────────────────────────────────────────────────────
 * Exports a shared Redis client.
 *   • Single-node  → use REDIS_URL env var
 *   • Cluster mode → set REDIS_CLUSTER=true + REDIS_CLUSTER_NODES
 *     (comma-separated  host:port list)
 *
 * Includes:
 *   • Exponential back-off retry strategy (max 10 attempts)
 *   • Passive health check: ping every 30 s, log on failure
 *   • Lazy connect so the app boots even if Redis is momentarily down
 * ─────────────────────────────────────────────────────────────
 */

import Redis from "ioredis";
import logger from "./logger.js";

const MAX_RETRIES = 10;

function retryStrategy(times) {
  if (times > MAX_RETRIES) {
    logger.error("[Redis] Max reconnection attempts reached — giving up");
    return null; // stop retrying
  }
  const delay = Math.min(100 * 2 ** times, 10_000); // exponential, cap 10 s
  logger.warn(`[Redis] Reconnecting in ${delay} ms (attempt ${times})`);
  return delay;
}

function makeClient() {
  const useCluster =
    process.env.REDIS_CLUSTER === "true" && process.env.REDIS_CLUSTER_NODES;

  if (useCluster) {
    const nodes = process.env.REDIS_CLUSTER_NODES.split(",").map((node) => {
      const [host, port] = node.trim().split(":");
      return { host, port: Number(port) || 6379 };
    });

    logger.info(`[Redis] Starting in CLUSTER mode (${nodes.length} nodes)`);

    return new Redis.Cluster(nodes, {
      clusterRetryStrategy: retryStrategy,
      enableOfflineQueue: true,
      scaleReads: "slave",
      redisOptions: {
        password: process.env.REDIS_PASSWORD || undefined,
        tls: process.env.REDIS_TLS === "true" ? {} : undefined,
        lazyConnect: true,
        enableReadyCheck: false,
      },
    });
  }

  // Single-node
  if (!process.env.REDIS_URL) {
    logger.warn(
      "[Redis] REDIS_URL not set — Redis features (rate-limit, replay, GPS cache) will be DISABLED"
    );
    return null;
  }

  logger.info("[Redis] Starting in single-node mode");

  return new Redis(process.env.REDIS_URL, {
    retryStrategy,
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    lazyConnect: true,
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === "true" ? {} : undefined,
  });
}

const redisClient = makeClient();

/* ── Passive health check ── */
if (redisClient) {
  redisClient.on("connect", () => logger.info("[Redis] ✅ Connected"));
  redisClient.on("ready",   () => logger.info("[Redis] ✅ Ready"));
  redisClient.on("error",   (e) => logger.error(`[Redis] ❌ ${e.message}`));
  redisClient.on("close",   () => logger.warn("[Redis] ⚠️  Connection closed"));

  // Periodic ping every 30 s
  setInterval(async () => {
    try {
      await redisClient.ping();
    } catch (err) {
      logger.warn(`[Redis] Health ping failed: ${err.message}`);
    }
  }, 30_000);
}

export default redisClient;
