import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type Body = {
  transcription?: string;
  tone?: "Code" | "Casual" | "Formal";
  language?: "de" | "en";
  formatHint?: "default" | "bullets" | "code";
};

function cors(resp: NextResponse) {
  resp.headers.set("Access-Control-Allow-Origin", "*");
  resp.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "*");
  return resp;
}

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

const PROMPT_TEMPLATE = (
  raw: string,
  tone: string,
  lang: string,
  _formatHint: string,
) => `Du bist ein Transkriptions-Polierer. Deine EINZIGE Aufgabe: Sprache säubern.

SPRACHE: ${lang}
TON: ${tone}

REGELN:
1. ENTFERNE: Füllwörter (ähm, äh, also, sozusagen, quasi, halt, ne, oder so), Wiederholungen, Versprecher, Pausen-Geräusche
2. KORRIGIERE: Grammatik, Satzbau, Interpunktion - aber behalte den Inhalt exakt bei
3. TECH-BEGRIFFE: Korrigiere falsch erkannte Tech-Begriffe (use state → useState, shad cn → shadcn, react hook, Next.js)

WICHTIG:
- Gib NUR den korrigierten Text zurück
- KEINE Kommentare, KEINE Erklärungen, KEINE Markdown-Formatierung
- KEINE Interpretation was der User "meinen könnte"
- Der Output ist der polierte Text, nichts anderes

TEXT:
${raw}`;

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return cors(
      NextResponse.json({ error: "ANTHROPIC_API_KEY fehlt" }, { status: 500 }),
    );
  }

  const body = (await req.json()) as Body;
  const raw = body.transcription?.trim() ?? "";
  const tone = body.tone ?? "Code";
  const lang = body.language ?? "de";
  const formatHint = body.formatHint ?? "default";

  if (!raw) {
    return cors(
      NextResponse.json({ error: "Keine Transkription" }, { status: 400 }),
    );
  }

  const payload = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: "You polish voice dictations for coding tasks.",
    messages: [
      {
        role: "user",
        content: PROMPT_TEMPLATE(raw, tone, lang, formatHint),
      },
    ],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const err = await res.text();
      console.error("Anthropic error", res.status, err);
      return cors(
        NextResponse.json(
          { error: `Polish fehlgeschlagen (${res.status})` },
          { status: 502 },
        ),
      );
    }

    const json = await res.json();
    const text = json?.content?.[0]?.text?.trim() || "";

    return cors(NextResponse.json({ text }));
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof Error && error.name === "AbortError") {
      console.error("Anthropic timeout");
      return cors(
        NextResponse.json({ error: "Timeout nach 30s" }, { status: 504 }),
      );
    }
    console.error(error);
    return cors(
      NextResponse.json({ error: "Polish failed" }, { status: 500 }),
    );
  }
}

