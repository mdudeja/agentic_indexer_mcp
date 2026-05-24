import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { symbols } from './symbols.schema'
import { imports } from './imports.schema'

export const symbol_calls = sqliteTable(
  'symbol_calls',
  {
    id: text().primaryKey(),
    caller_id: text()
      .notNull()
      .references(() => symbols.id, { onDelete: 'cascade' }),
    callee_name: text().notNull(),
    language_name: text().notNull(),
    caller_file_path: text().notNull(),
    call_text: text().notNull(),
    docstring: text(),
    // Resolved at upsert time; null when the callee hasn't been indexed yet.
    // SET NULL rather than CASCADE so a callee re-index doesn't delete call records.
    callee_id: text().references(() => symbols.id, { onDelete: 'set null' }),
    imports_id: text().references(() => imports.id, { onDelete: 'set null' }),
    call_line: integer(),
    call_column: integer(),
  },
  (table) => [
    index('idx_symbol_calls_caller').on(table.caller_id),
    index('idx_symbol_calls_callee').on(table.callee_name),
    index('idx_symbol_calls_callee_id').on(table.callee_id),
    index('idx_symbol_calls_imports_id').on(table.imports_id),
  ],
)

export type IndexedSymbolCall = {
  Insert: typeof symbol_calls.$inferInsert
  Select: typeof symbol_calls.$inferSelect
  Update: Partial<typeof symbol_calls.$inferSelect>
}
