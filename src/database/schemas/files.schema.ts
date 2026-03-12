import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { getNowMillis } from 'src/utils/datetime'

export const files = sqliteTable(
  'files',
  {
    path: text('path').primaryKey(),
    hash: text('hash').notNull(),
    indexedAt: integer('indexed_at')
      .notNull()
      .$onUpdate(() => getNowMillis()),
    language: text('language'),
  },
  (table) => [
    index('idx_files_path').on(table.path),
    index('idx_files_hash').on(table.hash),
    index('idx_files_indexed_at').on(table.indexedAt),
  ],
)

export type IndexedFile = {
  Insert: typeof files.$inferInsert
  Select: typeof files.$inferSelect
  Update: Partial<typeof files.$inferSelect>
}
