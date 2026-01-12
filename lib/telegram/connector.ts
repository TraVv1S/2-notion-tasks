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

  const cleanTitle = extracted
    ? removeFirstUrlFromText(transcript, extracted) || extracted.url
    : transcript;

  const title50 = cleanTitle.trim().slice(0, 50).trim() || "Аудио";

  const createTaskResult = await notionConnector.createTask(
    title50,
    tgAuthor,
    url ?? undefined,
    transcript
  );

  return { createTaskResult, title: title50 };
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
