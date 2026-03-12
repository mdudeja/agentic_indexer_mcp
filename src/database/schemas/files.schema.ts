import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { getNowMillis } from 'src/utils/datetime'

export const files = sqliteTable(
  'files',
  {
    path: text().primaryKey(),
    hash: text().notNull(),
    indexed_at: integer()
      .notNull()
      .$onUpdate(() => getNowMillis()),
    language: text(),
  },
  (table) => [
    index('idx_files_path').on(table.path),
    index('idx_files_hash').on(table.hash),
    index('idx_files_indexed_at').on(table.indexed_at),
  ],
)

export type IndexedFile = {
  Insert: typeof files.$inferInsert
  Select: typeof files.$inferSelect
  Update: Partial<typeof files.$inferSelect>
}
