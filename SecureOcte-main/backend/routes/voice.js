import verifyToken from "../middlewares/verifyToken.js";
import logger from "../config/logger.js";
import express from "express";
import { decideMonitoringMode } from "../gemini.js";

const router = express.Router();

/* 🎤 Voice Command Decision */
router.post("/decision", verifyToken, async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({
        error: "Text is required",
      });
    }

    const decision = await decideMonitoringMode(text);

    res.json({ decision });
  } catch (err) {
    logger.error("Voice Decision Error:", err.message);
    res.status(500).json({ decision: "UNKNOWN" });
  }
});

export default router;
