import { Telegraf, Context } from "telegraf";
import notionConnector from "../notion/connector";
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
        if (!(ctx.message && "text" in ctx.message)) {
          await ctx.reply("Сообщение может быть только текстовым!");
          return;
        }
        if (!ctx.message.from.username) {
          ll("empty username");
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
          ctx.message.from.username,
          url ?? undefined
        );
        const createdTaskMessage =
          "Новая задача - [" +
          title +
          "](https://www.notion.so/" +
          notionConnector.convertTaskToUrl(createTaskResult) +
          ")";
        await ctx.reply(createdTaskMessage, {
          parse_mode: "Markdown",
        });
        ll(createdTaskMessage);
        if (ctx.message.from.id !== telegramOwnerId) {
          await bot.telegram.sendMessage(
            telegramOwnerId,
            createdTaskMessage + "\nАвтор: @" + ctx.message.from.username,
            {
              parse_mode: "Markdown",
            }
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
