/**
 * services/alertService.js  (HARDENED)
 * ─────────────────────────────────────────────────────────────
 * H3 — Uses enqueueAlert which enforces:
 *   • Job deduplication (alertId as jobId)
 *   • Max queue length guard (503 if at capacity)
 *   • Panic job priority
 * H7 — All enqueue outcomes logged
 * ─────────────────────────────────────────────────────────────
 */

import logger from "../config/logger.js";
import { enqueueAlert } from "../queues/alertQueue.js";

export async function triggerAlert(payload, user) {
  const job = {
    userId:      user.userId,
    alertId:     payload.alertId,
    latitude:    payload.latitude,
    longitude:   payload.longitude,
    alertReason: payload.alertReason || "MANUAL_PANIC",
    username:    user.username || payload.username || "Unknown",
    accuracy:    payload.accuracy,
    timestamp:   Date.now(),
  };

  // H7 — log every panic trigger attempt
  logger.info({ msg: "[AlertService] Panic trigger", alertId: job.alertId, userId: job.userId });

  const enqueued = await enqueueAlert(job);

  if (!enqueued) {
    // H3 — fail closed: queue at capacity or Redis down
    logger.error({ msg: "[AlertService] Enqueue failed — queue at capacity or unavailable", alertId: job.alertId });
    throw new Error("QUEUE_UNAVAILABLE");
  }

  logger.info({ msg: "[AlertService] Job enqueued", alertId: job.alertId });
}
