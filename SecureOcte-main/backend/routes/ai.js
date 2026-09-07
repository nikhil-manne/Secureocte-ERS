import verifyToken from "../middlewares/verifyToken.js";
import logger from "../config/logger.js";
import express from "express";
import rateLimit from "express-rate-limit";
import { chatWithGemini } from "../gemini.js";

const router = express.Router();

/* ── Rate limiter: 20 messages per user per 10 minutes ────── */
const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,   // 10 minutes
  max: 20,                     // max 20 requests per window
  keyGenerator: (req) => req.user?.userId || req.ip,  // per user, not per IP
  handler: (req, res) => {
    res.status(429).json({
      reply: "You've sent too many messages. Please wait a few minutes before trying again.",
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/* ---------- STATUS ---------- */
router.get("/", (req, res) => {
  res.json({ message: "✅ AI route active" });
});

/* ---------- CHAT ---------- */
router.post("/chat", verifyToken, chatLimiter, async (req, res) => {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages)) {
      return res.status(400).json({
        reply: "Invalid request format",
      });
    }

    const reply = await chatWithGemini(messages);
    res.json({ reply });
  } catch (err) {
    logger.error("AI error:", err);
    res.status(500).json({
      reply: "I'm here for you, but I'm having trouble responding right now.",
    });
  }
});

export default router;
