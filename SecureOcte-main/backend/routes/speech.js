import verifyToken from "../middlewares/verifyToken.js";
import logger      from "../config/logger.js";
import express     from "express";
import multer      from "multer";
import fs          from "fs";
import axios       from "axios";
import ffmpeg      from "fluent-ffmpeg";
import ffmpegPath  from "ffmpeg-static";
import { decideMonitoringMode } from "../gemini.js";

ffmpeg.setFfmpegPath(ffmpegPath);

const router = express.Router();

/* ── Multer: store uploads in /uploads, 10 MB limit ── */
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 10 * 1024 * 1024 },
});

/* ── Safe file cleanup helper — never throws ── */
function cleanupFiles(...paths) {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    } catch (_) {}
  }
}

/* ── Single-response guard — prevents ERR_HTTP_HEADERS_SENT ── */
function safeJson(res, status, body) {
  if (res.headersSent) return;
  res.status(status).json(body);
}

/* ============================================================
   POST /api/speech/transcribe
   Audio → transcript only
============================================================ */
router.post("/transcribe", upload.single("audio"), async (req, res) => {
  const inputPath  = req.file?.path ?? null;
  const outputPath = inputPath ? inputPath + ".wav" : null;

  try {
    if (!inputPath) return safeJson(res, 400, { error: "Audio file missing" });

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioFrequency(16000).audioChannels(1).format("wav")
        .on("end", resolve).on("error", reject)
        .save(outputPath);
    });

    const audioBytes = fs.readFileSync(outputPath).toString("base64");
    cleanupFiles(inputPath, outputPath);

    const speechResponse = await axios.post(
      `https://speech.googleapis.com/v1/speech:recognize?key=${process.env.GOOGLE_SPEECH_API_KEY}`,
      {
        config: { encoding: "LINEAR16", sampleRateHertz: 16000, languageCode: "en-IN", audioChannelCount: 1, enableAutomaticPunctuation: true },
        audio: { content: audioBytes },
      }
    );

    const transcript = speechResponse.data.results
      ?.map((r) => r.alternatives[0].transcript).join(" ") || "";

    return safeJson(res, 200, { transcript });

  } catch (err) {
    cleanupFiles(inputPath, outputPath);
    logger.error("❌ Speech Transcribe Error:", err.response?.data || err.message);
    return safeJson(res, 500, { error: "Speech transcription failed" });
  }
});

/* ============================================================
   POST /api/speech/command
   Audio → transcript + Gemini decision (WALK_MONITORING | CAB_MONITORING | SOS)

   Middleware order:
     1. upload.single()  — multer must run first on multipart
     2. verifyToken      — JWT + device binding

   replayProtection deliberately excluded: audio uploads take 8–15 s
   (ffmpeg + Google Speech + Gemini). replayProtection fails-closed on
   any Redis hiccup, returning 503. JWT + device binding is sufficient
   protection here.
============================================================ */
router.post("/command", upload.single("audio"), verifyToken, async (req, res) => {
  const inputPath  = req.file?.path ?? null;
  const outputPath = inputPath ? inputPath + ".wav" : null;

  try {
    if (!inputPath) return safeJson(res, 400, { error: "Audio file missing" });

    logger.info("🎤 Voice Command Received:", inputPath);

    /* Convert to WAV */
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioFrequency(16000).audioChannels(1).format("wav")
        .on("end", resolve).on("error", reject)
        .save(outputPath);
    });

    logger.info("✅ Converted WAV:", outputPath);

    /* WAV → Base64 */
    const audioBytes = fs.readFileSync(outputPath).toString("base64");

    /* Clean up temp files BEFORE the slow network calls */
    cleanupFiles(inputPath, outputPath);

    /* Google Speech-to-Text */
    const speechResponse = await axios.post(
      `https://speech.googleapis.com/v1/speech:recognize?key=${process.env.GOOGLE_SPEECH_API_KEY}`,
      {
        config: { encoding: "LINEAR16", sampleRateHertz: 16000, languageCode: "en-IN", audioChannelCount: 1, enableAutomaticPunctuation: true },
        audio: { content: audioBytes },
      }
    );

    const transcript =
      speechResponse.data.results?.[0]?.alternatives?.[0]?.transcript || "";

    if (!transcript) {
      logger.info("📭 No speech detected in audio");
      return safeJson(res, 200, { transcript: "", decision: "UNKNOWN", message: "No speech detected" });
    }

    logger.info("📝 Transcript:", transcript);

    /* Gemini decision */
    const decision = await decideMonitoringMode(transcript);
    logger.info("🤖 Decision:", decision);

    return safeJson(res, 200, { transcript, decision });

  } catch (err) {
    /* Always clean up — even if already deleted, cleanupFiles is safe */
    cleanupFiles(inputPath, outputPath);

    logger.error("❌ Speech Command Error:", err.response?.data || err.message);

    /* Guard: only send if headers not already sent by verifyToken / multer */
    return safeJson(res, 500, {
      error: "Speech command processing failed",
      detail: err.message,
    });
  }
});

export default router;
