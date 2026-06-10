import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { getNowMillis } from 'src/utils/datetime'

export const tool_usage = sqliteTable(
  'tool_usage',
  {
    id: text().primaryKey(),
    tool_name: text().notNull(),
    called_at: integer().$default(() => getNowMillis()),
    tokens_saved: integer().notNull(),
    source_tokens: integer().notNull(),
    response_tokens: integer().notNull(),
  },
  (table) => [
    index('idx_tool_usage_tool_name').on(table.tool_name),
    index('idx_tool_usage_called_at').on(table.called_at),
  ],
)

export type ToolUsageRecord = {
  Insert: typeof tool_usage.$inferInsert
  Select: typeof tool_usage.$inferSelect
}
