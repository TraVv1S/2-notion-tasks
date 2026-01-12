import debug from "debug";
import env from "../../env";

const ll = debug("notionbot::groqConnector");

const GROQ_TRANSCRIPTIONS_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";

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
};
