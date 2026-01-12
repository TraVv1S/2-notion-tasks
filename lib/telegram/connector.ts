import { Telegraf, Context } from "telegraf";
import notionConnector from "../notion/connector";
import groqConnector from "../groq/connector";
import env from "../../env";
import debug from "debug";

const ll = debug("notionbot::telegramConnector");
const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);
const telegramOwnerId = env.TELEGRAM_OWNER_ID;
const allowTelegramIds = env.TELEGRAM_ALLOW_IDS;

type ExtractedUrl = { raw: string; url: string };

function extractFirstUrl(text: string): ExtractedUrl | null {
  const match = text.match(/\bhttps?:\/\/[^\s<>()]+|\bwww\.[^\s<>()]+/i);
  if (!match) return null;

  const raw = match[0].replace(/[),.;!?]+$/g, "");
  let url = raw;
  if (/^www\./i.test(url)) url = `https://${url}`;

  return { raw, url };
}

function removeFirstUrlFromText(text: string, extracted: ExtractedUrl): string {
  let result = text;

  result = result.replace(extracted.raw, " ");

  if (extracted.url !== extracted.raw) {
    result = result.replace(extracted.url, " ");
  }

  return result.replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function splitIntoChunks(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + chunkSize));
    i += chunkSize;
  }
  return chunks;
}

async function createNotionTaskFromText(text: string, tgAuthor: string) {
  const extracted = extractFirstUrl(text);
  const url = extracted?.url;
  const title = extracted
    ? removeFirstUrlFromText(text, extracted) || extracted.url
    : text;
  const createTaskResult = await notionConnector.createTask(
    title,
    tgAuthor,
    url ?? undefined
  );
  return { createTaskResult, title };
}

async function createNotionTaskFromAudioTranscript(
  transcript: string,
  tgAuthor: string
) {
  const extracted = extractFirstUrl(transcript);
  const url = extracted?.url;

  const llmInput = transcript.trim();
  const llmTextForPrompt =
    llmInput.length > 12000 ? llmInput.slice(0, 12000) : llmInput;

  let llmTitle = "";
  let tldr: string[] = [];
  try {
    const res = await groqConnector.generateTitleAndTldrRu(llmTextForPrompt);
    llmTitle = res.title;
    tldr = res.tldr;
  } catch (e) {
    ll("groq llm failed", String(e));
  }

  // ensure no URL leaks into the generated title
  const titleExtracted = llmTitle ? extractFirstUrl(llmTitle) : null;
  const cleanGeneratedTitle = llmTitle
    ? titleExtracted
      ? removeFirstUrlFromText(llmTitle, titleExtracted)
      : llmTitle
    : "";

  const fallbackTitleBase = extracted
    ? removeFirstUrlFromText(transcript, extracted) || extracted.url
    : transcript;

  const finalTitle =
    (cleanGeneratedTitle || fallbackTitleBase).trim().slice(0, 80).trim() ||
    "Аудио";

  const childrenBlocks: any[] = [];

  if (tldr.length > 0) {
    childrenBlocks.push({
      object: "block" as const,
      type: "heading_3" as const,
      heading_3: {
        rich_text: [{ type: "text" as const, text: { content: "TLDR" } }],
      },
    });
    for (const bullet of tldr.slice(0, 7)) {
      childrenBlocks.push({
        object: "block" as const,
        type: "bulleted_list_item" as const,
        bulleted_list_item: {
          rich_text: [{ type: "text" as const, text: { content: bullet } }],
        },
      });
    }
  }

  childrenBlocks.push({
    object: "block" as const,
    type: "divider" as const,
    divider: {},
  });
  childrenBlocks.push({
    object: "block" as const,
    type: "heading_3" as const,
    heading_3: {
      rich_text: [{ type: "text" as const, text: { content: "Расшифровка" } }],
    },
  });

  // Notion block limits are easy to hit; keep it conservative
  const transcriptChunks = splitIntoChunks(transcript, 1900).slice(0, 70);
  for (const chunk of transcriptChunks) {
    childrenBlocks.push({
      object: "block" as const,
      type: "paragraph" as const,
      paragraph: {
        rich_text: [{ type: "text" as const, text: { content: chunk } }],
      },
    });
  }

  const createTaskResult = await notionConnector.createTask(
    finalTitle,
    tgAuthor,
    url ?? undefined,
    undefined,
    childrenBlocks
  );

  return { createTaskResult, title: finalTitle };
}

export default {
  run: function () {
    bot.start((ctx) =>
      ctx.reply(
        "Добро пожаловать в бот для задач. Пишите свою задачу!\nВаш Telegram id - " +
          ctx.from.id
      )
    );
    bot.on("message", async function (ctx: Context) {
      ll("newMessage from " + ctx.message?.from.id);
      if (
        ctx.message?.from.id != telegramOwnerId &&
        allowTelegramIds.findIndex((e) => e === ctx.message?.from.id) === -1
      ) {
        await ctx.reply("Вы не имеете доступа к постановке задач");
      } else {
        if (!ctx.message.from.username) {
          ll("empty username");
          return;
        }
        const author = ctx.message.from.username;

        // Voice / audio -> Groq Speech-to-Text (Russian) -> Notion task
        if ("voice" in ctx.message || "audio" in ctx.message) {
          if (!env.GROQ_TOKEN) {
            await ctx.reply("Не настроен GROQ_TOKEN для расшифровки аудио.");
            return;
          }

          const audioMsg = ctx.message as any;
          const fileId: string =
            audioMsg.voice?.file_id || audioMsg.audio?.file_id;
          const mimeType: string | undefined =
            audioMsg.voice?.mime_type || audioMsg.audio?.mime_type;
          const guessExt = (type?: string) => {
            if (!type) return "bin";
            if (type.includes("ogg")) return "ogg";
            if (type.includes("mpeg") || type.includes("mp3")) return "mp3";
            if (type.includes("webm")) return "webm";
            if (type.includes("wav")) return "wav";
            if (type.includes("m4a") || type.includes("mp4")) return "m4a";
            return "bin";
          };
          const fileName: string =
            audioMsg.audio?.file_name ||
            `${audioMsg.voice ? "voice" : "audio"}.${guessExt(mimeType)}`;

          await ctx.reply("Принял аудио. Расшифровываю…");

          const fileLink = await bot.telegram.getFileLink(fileId);
          const transcript = await groqConnector.transcribeRussianFromUrl({
            fileUrl: String(fileLink),
            fileName,
            mimeType,
          });

          const { createTaskResult, title } =
            await createNotionTaskFromAudioTranscript(transcript, author);
          const titleForMessage = escapeHtml(title);
          const createdTaskMessage = `Новая задача - <a href="https://www.notion.so/${notionConnector.convertTaskToUrl(
            createTaskResult
          )}">${titleForMessage}</a>`;

          await ctx.reply(createdTaskMessage, { parse_mode: "HTML" });
          ll(createdTaskMessage);

          if (ctx.message.from.id !== telegramOwnerId) {
            await bot.telegram.sendMessage(
              telegramOwnerId,
              `${createdTaskMessage}\nАвтор: @${escapeHtml(author)}`,
              { parse_mode: "HTML" }
            );
          }

          return;
        }

        // Text messages -> Notion task
        if (!(ctx.message && "text" in ctx.message)) {
          await ctx.reply("Сообщение может быть только текстовым или аудио!");
          return;
        }

        const originalText = ctx.message.text;
        const extracted = extractFirstUrl(originalText);
        const url = extracted?.url;
        const title = extracted
          ? removeFirstUrlFromText(originalText, extracted) || extracted.url
          : originalText;

        const createTaskResult = await notionConnector.createTask(
          title,
          author,
          url ?? undefined
        );
        const createdTaskMessage = `Новая задача - <a href="https://www.notion.so/${notionConnector.convertTaskToUrl(
          createTaskResult
        )}">${escapeHtml(title)}</a>`;

        await ctx.reply(createdTaskMessage, { parse_mode: "HTML" });
        ll(createdTaskMessage);
        if (ctx.message.from.id !== telegramOwnerId) {
          await bot.telegram.sendMessage(
            telegramOwnerId,
            `${createdTaskMessage}\nАвтор: @${escapeHtml(author)}`,
            { parse_mode: "HTML" }
          );
        }
      }
    });

    process.once("SIGINT", () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));

    return bot.launch().then(() => {
      ll("bot started");
    });
  },
};
