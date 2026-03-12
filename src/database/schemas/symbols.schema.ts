import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { files } from './files.schema'
import { customEnum } from './common.schema'

export enum SymbolKind {
  function = 'function',
  class = 'class',
  interface = 'interface',
  type = 'type',
  variable = 'variable',
  property = 'property',
  method = 'method',
  constructor = 'constructor',
  enum = 'enum',
  enumMember = 'enumMember',
  namespace = 'namespace',
  module = 'module',
}

export const symbols = sqliteTable(
  'symbols',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    kind: customEnum<SymbolKind>('kind').notNull(),
    filePath: text('file_path')
      .notNull()
      .references(() => files.path, { onDelete: 'cascade' }),
    line: integer('line').notNull(),
    column: integer('column').notNull(),
    endLine: integer('end_line'),
    endColumn: integer('end_column'),
    signature: text('signature'),
    docstring: text('docstring'),
    parentId: text('parent_id'),
    exported: integer('exported', { mode: 'boolean' }).default(false),
  },
  (table) => [
    index('idx_symbols_name').on(table.name),
    index('idx_symbols_kind').on(table.kind),
    index('idx_symbols_file').on(table.filePath),
  ],
)

export type IndexedSymbol = {
  Insert: typeof symbols.$inferInsert
  Select: typeof symbols.$inferSelect
  Update: Partial<typeof symbols.$inferSelect>
}
