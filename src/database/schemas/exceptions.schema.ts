import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { symbols } from './symbols.schema.ts'
import { files } from './files.schema.ts'

export const exceptions = sqliteTable(
  'exceptions',
  {
    id: text().primaryKey(),
    symbol_id: text()
      .notNull()
      .references(() => symbols.id, { onDelete: 'cascade' }),
    file_path: text()
      .notNull()
      .references(() => files.path, { onDelete: 'cascade' }),
    exception_type: text().notNull(),
    line: integer().notNull(),
    column: integer().notNull(),
  },
  (table) => [
    index('idx_exceptions_symbol').on(table.symbol_id),
    index('idx_exceptions_file').on(table.file_path),
  ]
)

export type IndexedException = {
  Insert: typeof exceptions.$inferInsert
  Select: typeof exceptions.$inferSelect
}
