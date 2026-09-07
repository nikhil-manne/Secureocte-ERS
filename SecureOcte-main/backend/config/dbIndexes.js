/**
 * config/dbIndexes.js
 * ─────────────────────────────────────────────────────────────
 * Ensures all critical MongoDB indexes exist at startup.
 * Call once after mongoose connects.
 *
 * Indexes defined:
 *   alerts (Panic)   → userId + createdAt (compound)
 *   streams          → streamId (unique), expiresAt (TTL 24 h)
 *   trips (PatrolTrip + CabEscortTrip) → userId + isActive
 * ─────────────────────────────────────────────────────────────
 */

import mongoose from "mongoose";
import logger from "./logger.js";

export async function ensureIndexes() {
  try {
    const db = mongoose.connection.db;

    /* ── alerts (Panic collection) ── */
    await db.collection("panics").createIndexes([
      { key: { userId: 1, createdAt: -1 }, name: "userId_createdAt" },
    ]);

    /* ── streams (LiveStream collection) ── */
    await db.collection("livestreams").createIndexes([
      { key: { streamId: 1 }, name: "streamId_unique", unique: true },
      {
        key: { expiresAt: 1 },
        name: "streamId_ttl",
        expireAfterSeconds: 0, // TTL driven by the document's expiresAt field
      },
    ]);

    /* ── trips ── */
    await db.collection("patroltrips").createIndexes([
      { key: { userId: 1, isActive: 1 }, name: "userId_isActive" },
    ]);
    await db.collection("cabescorttrips").createIndexes([
      { key: { userId: 1, status: 1 }, name: "userId_status" },
    ]);

    /* ── userlocations ── */
    await db.collection("userlocations").createIndexes([
      { key: { userId: 1, updatedAt: -1 }, name: "userId_updatedAt" },
      { key: { alertId: 1 }, name: "alertId" },
    ]);

    logger.info("[DB] ✅ All indexes ensured");
  } catch (err) {
    logger.error(`[DB] ❌ Index creation failed: ${err.message}`);
  }
}
