/**
 * server.js  (v3 — fully patched)
 * ─────────────────────────────────────────────────────────────
 * Patch summary applied:
 *   FIX 1  — single /middlewares folder, /middleware deleted
 *   FIX 2  — replayProtection fails closed (503 on Redis error)
 *   FIX 3  — strict device binding, no legacy bypass
 *   FIX 4  — panicRoutes.js is the single panic route (no DB in handler)
 *   FIX 5  — queue retry: attempts=3, exponential backoff
 *   FIX 6  — stream 404/410 checks + limiter + auth
 *   FIX 7  — globalErrorHandler matches spec exactly
 *   FIX 8  — all console.* replaced with logger
 *   FIX 9  — GPS teleport check present, TTL=60s
 *   FIX 10 — Redis keys: replay:{nonce}, gps:{key}, rl:{scope}:
 *   FIX 11 — /health checks db, redis, queue; returns { status:"ok" }
 * ─────────────────────────────────────────────────────────────
 */

import express from "express";
import { createServer } from "http";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { initSocketServer } from "./socket/socketManager.js";
import { startNetworkMonitor } from "./services/networkMonitor.js";

/* ── Hardened middleware (all from /middlewares) ── */
import { helmetStrict, helmetStream, streamCsp } from "./middlewares/helmetConfig.js";
import distributedRateLimit from "./middlewares/distributedRateLimit.js";
import globalErrorHandler from "./middlewares/globalErrorHandler.js";
import logger from "./config/logger.js";
import { ensureIndexes } from "./config/dbIndexes.js";
import { startAlertWorker } from "./queues/alertQueue.js";
import healthRoute from "./monitoring/healthRoute.js";

/* ── Routes — FIX 1: import panicRoutes (not panic.js) ── */
import panicRoutes from "./routes/panicRoutes.js";
import authRoutes from "./routes/auth.js";
import streamRoutes from "./routes/stream.js";
import aiRoutes from "./routes/ai.js";
import walkRoutes from "./routes/walk.js";
import speechRoutes from "./routes/speech.js";
import voiceRoutes from "./routes/voice.js";
import cabEscortRoutes from "./routes/cabEscortRoutes.js";
import statsRoutes from "./routes/stats.js";
import incidentRoutes from "./routes/incidentRoutes.js";
import patrolRoutes from "./routes/Patrolroutes.js";
import networkAlertsRoutes from "./routes/networkAlert.js";

/* ── CJS ── */
const require = createRequire(import.meta.url);
const securemeRoute = require("./routes/secureme.cjs");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const httpServer = createServer(app);
const { io, redisWrite } = initSocketServer(httpServer);  // WebSocket layer + Redis write client
app.set("trust proxy", 1);

/* ─────────────────────────────────────────────
   HOST VALIDATION
───────────────────────────────────────────── */
app.use((req, res, next) => {
  if (req.path.startsWith("/stream/")) return next();
  const allowedHost = process.env.ALLOWED_HOST || "server-r9k4.onrender.com";
  if (!req.headers.host || !req.headers.host.endsWith(allowedHost)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
});

/* ─────────────────────────────────────────────
   CORS
───────────────────────────────────────────── */
app.use("/stream", cors({ origin: "*", methods: ["GET"] }));
app.use("/api/stream", cors({
  origin: (origin, cb) => cb(null, true),
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
}));
app.use(cors({
  origin: (origin, cb) => {
    const allowed = [
      "http://127.0.0.1:5500",
      "http://localhost:5500",
      "https://dashboard-ten-omega-12.vercel.app",
      ...(process.env.EXTRA_CORS_ORIGINS || "").split(",").filter(Boolean),
    ];
    if (!origin || allowed.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Device-Id",
    "X-Timestamp",
    "X-Nonce",
    "X-Mobility-Mode",
  ],
  credentials: true,
}));

/* ─────────────────────────────────────────────
   HELMET
───────────────────────────────────────────── */
app.use("/stream", helmetStream, streamCsp);
app.use((req, res, next) => {
  if (req.path.startsWith("/stream")) return next();
  helmetStrict(req, res, next);
});

/* ─────────────────────────────────────────────
   BODY PARSER — 100 kb cap
───────────────────────────────────────────── */
app.use(express.json({ limit: "100kb" }));

/* ─────────────────────────────────────────────
   REQUEST TIMEOUT — 10 s
───────────────────────────────────────────── */
app.use((req, res, next) => {
  res.setTimeout(10_000, () => {
    logger.warn({ msg: "[Timeout]", method: req.method, path: req.path });
    res.status(503).json({ error: "Request timeout" });
  });
  next();
});

/* ─────────────────────────────────────────────
   DISTRIBUTED RATE LIMIT (Redis-backed)
───────────────────────────────────────────── */
app.use(distributedRateLimit);

/* ─────────────────────────────────────────────
   STRUCTURED REQUEST LOGGING — pino
───────────────────────────────────────────── */
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
      ip: req.ip,
    });
  });
  next();
});

/* ─────────────────────────────────────────────
   STATIC FILES
───────────────────────────────────────────── */
app.use(express.static(path.join(__dirname, "public")));

/* ─────────────────────────────────────────────
   ROUTES
───────────────────────────────────────────── */
app.use("/api/panic", panicRoutes);       // FIX 1 + 4 — panicRoutes.js
app.use("/api/auth", authRoutes);
app.use("/api/stream", streamRoutes);
app.use("/api/cab-escort", cabEscortRoutes);
app.use("/api/patrol", patrolRoutes);
app.use("/api/walk", walkRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/incident", incidentRoutes);
app.use("/api/network-alerts", networkAlertsRoutes);
app.use("/api/secureme", securemeRoute);
app.use("/api/speech", speechRoutes);
app.use("/api/voice", voiceRoutes);
app.use("/ai", aiRoutes);

app.get("/stream/:streamId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "stream.html"));
});

/* ── Health probe ── */
app.use("/health", healthRoute);

/* ─────────────────────────────────────────────
   GLOBAL ERROR HANDLER — must be last
───────────────────────────────────────────── */
app.use(globalErrorHandler);

/* ─────────────────────────────────────────────
   BOOT
───────────────────────────────────────────── */
const PORT = process.env.PORT || 4000;

mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    logger.info("✅ MongoDB connected");
    await ensureIndexes();
    startAlertWorker();
    startNetworkMonitor(redisWrite, io);   // ← Network monitor watchdog
    httpServer.listen(PORT, () => logger.info({ msg: "🚀 Server started", port: PORT }));
  })
  .catch((err) => {
    logger.error({ msg: "❌ MongoDB connection failed", err: err.message });
    process.exit(1);
  });
