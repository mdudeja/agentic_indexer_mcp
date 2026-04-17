import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core'
import { files } from './files.schema'

export const imports = sqliteTable(
  'imports',
  {
    id: text().primaryKey(),
    file_path: text()
      .notNull()
      .references(() => files.path, { onDelete: 'cascade' }),
    module_name: text().notNull(),
    imported_name: text(),
  },
  (table) => [
    index('idx_imports_file').on(table.file_path),
    index('idx_imports_module').on(table.module_name),
  ],
)

export type IndexedImport = {
  Insert: typeof imports.$inferInsert
  Select: typeof imports.$inferSelect
  Update: Partial<typeof imports.$inferSelect>
}
