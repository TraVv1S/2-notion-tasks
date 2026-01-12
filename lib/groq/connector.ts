import debug from "debug";
import env from "../../env";

const ll = debug("notionbot::groqConnector");

const GROQ_TRANSCRIPTIONS_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_CHAT_COMPLETIONS_URL =
  "https://api.groq.com/openai/v1/chat/completions";

function getGroqToken(): string {
  const token = env.GROQ_TOKEN;
  if (!token) {
    throw new Error("GROQ_TOKEN is not configured");
  }
  return token;
}

export type GroqTranscriptionOptions = {
  fileUrl: string;
  fileName: string;
  mimeType?: string;
};

async function fetchFileAsArrayBuffer(fileUrl: string): Promise<ArrayBuffer> {
  const res = await fetch(fileUrl);
  if (!res.ok) {
    throw new Error(`Failed to download Telegram file: ${res.status}`);
  }
  return await res.arrayBuffer();
}

function safeParseJsonObject(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    // try to extract the first JSON object from mixed text
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export type GroqTitleAndTldr = {
  title: string;
  tldr: string[];
};

export default {
  transcribeRussianFromUrl: async function (
    opts: GroqTranscriptionOptions
  ): Promise<string> {
    const token = getGroqToken();
    ll("transcribing", opts.fileName);

    const audio = await fetchFileAsArrayBuffer(opts.fileUrl);
    const form = new FormData();
    const blob = new Blob([audio], {
      type: opts.mimeType || "application/octet-stream",
    });

    form.append("file", blob, opts.fileName);
    form.append("model", "whisper-large-v3");
    form.append("language", "ru");
    form.append("response_format", "json");
    form.append("temperature", "0");

    const res = await fetch(GROQ_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: form,
    });

    const payloadText = await res.text();
    if (!res.ok) {
      throw new Error(
        `Groq transcription failed: ${res.status} ${payloadText.slice(0, 500)}`
      );
    }

    const payload = JSON.parse(payloadText) as { text?: string };
    if (!payload.text) {
      throw new Error("Groq transcription returned empty text");
    }
    return payload.text;
  },

  generateTitleAndTldrRu: async function (
    transcript: string
  ): Promise<GroqTitleAndTldr> {
    const token = getGroqToken();
    ll("generating title+tldr");

    const body = {
      model: "llama-3.1-8b-instant",
      temperature: 0.2,
      max_tokens: 256,
      messages: [
        {
          role: "system",
          content:
            'Ты помощник, который генерирует заголовок и TLDR по расшифровке аудио на русском языке. Верни ТОЛЬКО валидный JSON вида {"title": "...", "tldr": ["...", "..."]}. ' +
            "Правила: title <= 80 символов, без ссылок/URL и без кавычек-ёлочек. tldr: 3-7 коротких тезисов (каждый <= 140 символов).",
        },
        {
          role: "user",
          content:
            "Расшифровка (русский язык). Сгенерируй JSON как описано выше:\n\n" +
            transcript,
        },
      ],
    };

    const res = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const payloadText = await res.text();
    if (!res.ok) {
      throw new Error(
        `Groq chat completion failed: ${res.status} ${payloadText.slice(
          0,
          500
        )}`
      );
    }

    const payload = JSON.parse(payloadText) as any;
    const content: string | undefined =
      payload?.choices?.[0]?.message?.content ?? undefined;
    if (!content) {
      throw new Error("Groq chat completion returned empty content");
    }

    const obj = safeParseJsonObject(content);
    const title = typeof obj?.title === "string" ? obj.title.trim() : "";
    const tldrRaw = Array.isArray(obj?.tldr) ? obj.tldr : [];
    const tldr = tldrRaw
      .filter((x: any) => typeof x === "string")
      .map((x: string) => x.trim())
      .filter((x: string) => x.length > 0)
      .slice(0, 7);

    if (!title || tldr.length === 0) {
      throw new Error(
        `Groq returned invalid JSON content: ${content.slice(0, 500)}`
      );
    }

    return { title, tldr };
  },
};
