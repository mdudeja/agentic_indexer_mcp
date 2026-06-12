import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { symbols } from './symbols.schema.ts'
import { files } from './files.schema.ts'

export const env_vars = sqliteTable(
  'env_vars',
  {
    id: text().primaryKey(),
    symbol_id: text()
      .notNull()
      .references(() => symbols.id, { onDelete: 'cascade' }),
    file_path: text()
      .notNull()
      .references(() => files.path, { onDelete: 'cascade' }),
    name: text().notNull(),
    line: integer().notNull(),
    column: integer().notNull(),
  },
  (table) => [
    index('idx_env_vars_symbol').on(table.symbol_id),
    index('idx_env_vars_file').on(table.file_path),
  ],
)

export type IndexedEnvVar = {
  Insert: typeof env_vars.$inferInsert
  Select: typeof env_vars.$inferSelect
  Update: Partial<typeof env_vars.$inferSelect>
}
