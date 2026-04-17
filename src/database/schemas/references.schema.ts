import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core'
import { files } from './files.schema'

export const symbol_references = sqliteTable(
  'symbol_references',
  {
    id: text().primaryKey(),
    file_path: text()
      .notNull()
      .references(() => files.path, { onDelete: 'cascade' }),
    caller_symbol_id: text(),
    callee_name: text().notNull(),
  },
  (table) => [
    index('idx_refs_file').on(table.file_path),
    index('idx_refs_callee').on(table.callee_name),
    index('idx_refs_caller').on(table.caller_symbol_id),
  ],
)

export type SymbolReference = {
  Insert: typeof symbol_references.$inferInsert
  Select: typeof symbol_references.$inferSelect
  Update: Partial<typeof symbol_references.$inferSelect>
}
