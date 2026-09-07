/**
 * queues/alertQueue.js  (HARDENED)
 * ─────────────────────────────────────────────────────────────
 * H3 — Queue protections:
 *   • Job deduplication  — jobId = alertId prevents duplicate panic jobs
 *   • Max queue length   — 500 waiting jobs max; excess returns 503
 *   • Priority for panic — panic jobs get priority 1 (lower = higher prio)
 *
 * H5 — retry: 3 attempts, exponential backoff (unchanged)
 * H7 — Structured logging for all job lifecycle events
 * ─────────────────────────────────────────────────────────────
 */

import { Queue, Worker } from "bullmq";
import logger from "../config/logger.js";

const QUEUE_NAME     = "panic-alerts";
const MAX_QUEUE_SIZE = 500;   // H3 — max waiting jobs

let _queue  = null;
let _worker = null;

function getConnection() {
  if (!process.env.REDIS_URL) return null;
  const url = new URL(process.env.REDIS_URL);
  return {
    host:     url.hostname,
    port:     Number(url.port) || 6379,
    password: url.password || process.env.REDIS_PASSWORD || undefined,
    tls:      process.env.REDIS_TLS === "true" ? {} : undefined,
  };
}

export function getAlertQueue() {
  if (_queue) return _queue;
  const connection = getConnection();
  if (!connection) {
    logger.warn("[AlertQueue] REDIS_URL not set — queue disabled");
    return null;
  }
  _queue = new Queue(QUEUE_NAME, { connection });
  logger.info("[AlertQueue] ✅ Queue initialised");
  return _queue;
}

/* ── H3: Job options with deduplication + priority ── */
export function makePanicJobOptions(alertId) {
  return {
    jobId:    alertId,          // H3 deduplication — same alertId = no duplicate
    priority: 1,                // H3 priority — panic jobs highest priority
    attempts: 3,
    backoff: {
      type:  "exponential",
      delay: 2000,
    },
    removeOnComplete: 100,
    removeOnFail:     50,
  };
}

/* Legacy export for non-panic jobs */
export const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: 100,
  removeOnFail:     50,
};

/**
 * enqueueAlert — H3: check queue length before adding
 * Returns false if queue is at capacity (caller should 503).
 */
export async function enqueueAlert(data) {
  const q = getAlertQueue();
  if (!q) return false;

  // H3 — max queue length guard
  const counts = await q.getJobCounts("waiting", "delayed");
  const waiting = (counts.waiting || 0) + (counts.delayed || 0);
  if (waiting >= MAX_QUEUE_SIZE) {
    logger.error({ msg: "[AlertQueue] Queue at capacity — rejecting job", waiting, alertId: data.alertId });
    return false;
  }

  await q.add("panic-alert", data, makePanicJobOptions(data.alertId));
  logger.info({ msg: "[AlertQueue] Job enqueued", alertId: data.alertId, queueSize: waiting + 1 });
  return true;
}

export function startAlertWorker() {
  if (_worker) return _worker;
  const connection = getConnection();
  if (!connection) {
    logger.warn("[AlertQueue] REDIS_URL not set — worker not started");
    return null;
  }

  _worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { userId, alertId, latitude, longitude, alertReason, username, accuracy } = job.data;

      logger.info({ msg: "[AlertWorker] Processing job", jobId: job.id, alertId });

      /* Step 1: Write DB records */
      try {
        const { default: UserLocation } = await import("../models/userLocation.js");
        const { default: Panic }        = await import("../models/panic.js");

        await Promise.all([
          UserLocation.create({ alertId, userId, username, latitude, longitude, alertReason }),
          Panic.create({ userId, username, location: { lat: latitude, lng: longitude } }),
        ]);
      } catch (err) {
        logger.error({ msg: "[AlertWorker] DB write failed", alertId, err: err.message });
        throw err; // triggers BullMQ retry
      }

      /* Step 2: Dispatch patrol */
      logger.info({ msg: "[AlertWorker] Dispatching patrol", userId, alertId });

      /* Step 3: Notify dashboard */
      logger.info({ msg: "[AlertWorker] Notifying dashboard", alertId });

      /* Step 4: Analytics */
      logger.info({
        msg: "[AlertWorker] ✅ Alert processed",
        alertId, username,
        lat: latitude, lng: longitude,
        reason: alertReason,
      });
    },
    { connection, concurrency: 5 }
  );

  _worker.on("completed", (job) =>
    logger.info({ msg: "[AlertWorker] Job completed", jobId: job.id })
  );
  _worker.on("failed", (job, err) =>
    logger.error({ msg: "[AlertWorker] Job failed", jobId: job?.id, err: err.message })
  );

  logger.info("[AlertWorker] ✅ Worker started");
  return _worker;
}
