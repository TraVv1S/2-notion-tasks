import { Client } from '@notionhq/client';
import { CreatePageResponse } from "@notionhq/client/build/src/api-endpoints";
import env from '../../env';
import debug from 'debug';

const ll = debug('notionbot::notionConnector');

const notion = new Client({
    auth: env!.NOTION_TOKEN,
});

const taskDB = env!.NOTION_TASK_DB;

function splitIntoChunks(text: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    let i = 0;
    while (i < text.length) {
        chunks.push(text.slice(i, i + chunkSize));
        i += chunkSize;
    }
    return chunks;
}

export default {
    createTask: function (
        title: string,
        tgAuthor: string,
        url?: string,
        body?: string,
        childrenBlocks?: any[]
    ): Promise<CreatePageResponse> {
        ll('creating task', title, 'from', tgAuthor, url ? `with url ${url}` : '');
        const properties: any = {
            Name: {
                type: "title",
                title: [
                    {
                        type: "text",
                        text: {
                            content: title
                        }
                    }
                ]
            },
            TGAuthor: {
                type: "rich_text",
                rich_text: [
                    {
                        type: "text",
                        text: {
                            content: tgAuthor
                        }
                    }
                ]
            },
            Status: {
                type: "select",
                select: {
                    name: 'Backlog'
                }
            },
            Source: {
                type: "select",
                select: {
                    name: 'Telegram'
                }
            }
        };

        if (url) {
            properties.URL = {
                type: "url",
                url
            };
        }

        const children = childrenBlocks
            ? childrenBlocks
            : body
            ? splitIntoChunks(body, 1900).slice(0, 90).map((chunk) => ({
                object: "block" as const,
                type: "paragraph" as const,
                paragraph: {
                    rich_text: [
                        {
                            type: "text" as const,
                            text: { content: chunk }
                        }
                    ]
                }
            }))
            : undefined;

        return notion.pages.create({
            parent: {
                database_id: taskDB
            },
            properties,
            ...(children ? { children } : {})

        });
    },
    convertTaskToUrl: function (task: CreatePageResponse): string {
        return task.id.replace(/-/g, ''); // конвертируем id в рабочий для ссылки
    }
};
