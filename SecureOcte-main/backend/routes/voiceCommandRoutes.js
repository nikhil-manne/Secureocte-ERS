import verifyToken from "../middlewares/verifyToken.js";
import express from "express";
import { decideMonitoringMode } from "../gemini.js";

const router = express.Router();

/* Gemini Decision */
router.post("/decision", verifyToken, async (req, res) => {
  const { text } = req.body;

  const decision = await decideMonitoringMode(text);

  res.json({ decision });
});

export default router;
