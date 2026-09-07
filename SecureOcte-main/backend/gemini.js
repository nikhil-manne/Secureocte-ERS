import { GoogleGenAI } from "@google/genai";
import logger from "./config/logger.js";

/* =========================================================
   ✅ GEMINI CONFIG
========================================================= */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  throw new Error("❌ GEMINI_API_KEY is missing");
}

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
});

/* =========================================================
   ✅ 1. NEHA CHATBOT (UNCHANGED)
========================================================= */
export async function chatWithGemini(messages) {
  const systemPrompt = `
Your name is Neha.

Identity:
- You are Neha, an AI created by SecureOcte.
- You help women with travel safety guidance and emotional support.
- You stay with the user during travel to make them feel accompanied.
- You are NOT Gemini, NOT Google, NOT an AI model.

If asked who you are, reply:
"I’m Neha, an AI created by SecureOcte to support women with safety guidance and care."

Rules:
- Calm, empathetic, respectful
- Allow User to be Entertained as much as possible, tell them New Stories , jokes , Movie concepts etc...
- Never judge or blame
- Never say "you are safe"
- Never give legal or medical advice
- Never instruct confrontation
`;

  const conversation =
    systemPrompt +
    "\n\nConversation:\n" +
    messages.map((m) => `${m.role}: ${m.text}`).join("\n");

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: conversation,
  });

  return response.text;
}

/* =========================================================
   ✅ 2. AUTOMATED VOICE COMMAND PARSER
   🎯 Detects MODE + DESTINATION automatically
========================================================= */

export async function parseTripCommand(userText) {
  try {
    const prompt = `
You are a voice command understanding system.

User said:
"${userText}"

Extract intent and destination.

Return STRICT JSON ONLY in this format:

{
  "mode": "CAB_MONITORING | WALK_MONITORING | UNKNOWN",
  "destination": "<place name or null>"
}

Rules:
- Cab, auto, taxi, ride, trip, drop me → CAB_MONITORING
- Walk, walking, on foot → WALK_MONITORING
- Destination must be a real place name if mentioned
- If no destination is spoken, return null
- Do NOT add explanation
`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });

    const rawText = response.text.trim();

    // ✅ Defensive JSON parsing
    const jsonStart = rawText.indexOf("{");
    const jsonEnd = rawText.lastIndexOf("}");

    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error("Invalid JSON from Gemini");
    }

    const cleanJson = rawText.substring(jsonStart, jsonEnd + 1);
     

    return JSON.parse(cleanJson);
  } catch (err) {
    logger.error("❌ Voice Parse Error:", err.message);

    return {
      mode: "UNKNOWN",
      destination: null,
    };
     
  }
   const parsed = await parseTripCommand(text);
logger.info("Parsed Command:", parsed);

}

/* =========================================================
   ✅ 3. OPTIONAL: SIMPLE MODE-ONLY DECISION (FALLBACK)
========================================================= */

export async function decideMonitoringMode(userText) {
  try {
    const prompt = `
You are a safety voice command classifier for a women's safety app.

User said:
"${userText}"

Classify into EXACTLY one of these three commands:

WALK_MONITORING  — user wants to start walk monitoring / walking safety
CAB_MONITORING   — user wants to start cab / taxi / auto / ride monitoring
SOS              — user is in danger, needs help, says "help", "emergency", "SOS", "send SOS", "I'm scared", "danger", "call police", "save me", etc.

Return ONLY one word. No explanation. No punctuation.
`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });

    return response.text.trim();
  } catch (err) {
    logger.error("❌ Decision Error:", err.message);
    return "UNKNOWN";
  }
}
