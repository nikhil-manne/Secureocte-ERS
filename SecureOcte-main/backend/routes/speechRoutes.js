import express from "express";
import logger from "../config/logger.js";
import multer from "multer";
import axios from "axios";
import fs from "fs";

const router = express.Router();
const upload = multer({ dest: "uploads/" });

/* 🎤 Speech-to-Text Route */
router.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    const filePath = req.file.path;

    /* Convert audio to base64 */
    const audioBytes = fs.readFileSync(filePath).toString("base64");

    /* Google Speech API Call */
    const response = await axios.post(
      `https://speech.googleapis.com/v1/speech:recognize?key=${process.env.GOOGLE_SPEECH_API_KEY}`,
      {
        config: {
          encoding: "LINEAR16",
          languageCode: "en-IN",
        },
        audio: {
          content: audioBytes,
        },
      }
    );

    /* Extract Transcript */
    const transcript =
      response.data.results?.[0]?.alternatives?.[0]?.transcript || "";

    fs.unlinkSync(filePath);

    res.json({ transcript });
  } catch (err) {
    logger.error("Speech Error:", err.message);
    res.status(500).json({ error: "Speech transcription failed" });
  }
});

export default router;
