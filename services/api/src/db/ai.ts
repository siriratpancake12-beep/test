import type { Kysely } from "kysely";

/** AI 老师用量、发音评测用量的表。负责人:AI 与语音模块(server-ai)。 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AiTables {}

export async function migrateAi(_db: Kysely<any>): Promise<void> {}
