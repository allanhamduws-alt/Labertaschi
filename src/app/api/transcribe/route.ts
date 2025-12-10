import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Groq Whisper Large V3 - OpenAI-kompatible API
const GROQ_API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

function cors(resp: NextResponse) {
  resp.headers.set("Access-Control-Allow-Origin", "*");
  resp.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "*");
  return resp;
}

// Verwirf reine Satzzeichen/Stille-Ergebnisse (z.B. "." von Whisper)
function isTrivialTranscript(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return true;
  const lettersOrDigits = trimmed.replace(/[^\p{L}\p{N}]+/gu, "");
  if (!lettersOrDigits) return true;
  if (lettersOrDigits.length < 2 && trimmed.length <= 3) return true;
  return false;
}

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("GROQ_API_KEY nicht gesetzt");
    return cors(
      NextResponse.json({ error: "GROQ_API_KEY fehlt" }, { status: 500 }),
    );
  }

  try {
    const { searchParams } = new URL(req.url);
    const language = searchParams.get("language") ?? "de";

    const audioBuffer = Buffer.from(await req.arrayBuffer());

    if (audioBuffer.length < 100) {
      return cors(NextResponse.json({ transcript: "" }));
    }

    // Groq nutzt OpenAI-kompatibles multipart/form-data Format
    // Für Node.js: File-Objekt aus Buffer erstellen
    const audioFile = new File([audioBuffer], "audio.webm", {
      type: "audio/webm",
    });

    const formData = new FormData();
    formData.append("file", audioFile);
    formData.append("model", "whisper-large-v3");
    formData.append("language", language);
    formData.append("response_format", "json");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const groqRes = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error("Groq Whisper error", groqRes.status, errText);
      return cors(
        NextResponse.json(
          { error: `Transkription fehlgeschlagen (${groqRes.status})` },
          { status: 502 },
        ),
      );
    }

    const json = await groqRes.json();
    const rawTranscript = json?.text ?? "";
    const transcript = rawTranscript.trim();

    if (isTrivialTranscript(transcript)) {
      console.log("Groq transcript discarded (trivial)");
      return cors(NextResponse.json({ transcript: "" }));
    }

    console.log("Groq transcript:", transcript.substring(0, 50) + "...");
    return cors(NextResponse.json({ transcript }));
  } catch (error) {
    console.error("Transcribe error:", error);
    if (error instanceof Error && error.name === "AbortError") {
      return cors(
        NextResponse.json({ error: "Timeout nach 30s" }, { status: 504 }),
      );
    }
    return cors(
      NextResponse.json({ error: "Transcribe failed" }, { status: 500 }),
    );
  }
}
