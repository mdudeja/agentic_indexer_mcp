import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { files } from './files.schema'
import { customEnum } from './common.schema'

export enum SymbolKind {
  function = 'function',
  class = 'class',
  interface = 'interface',
  type = 'type',
  var = 'var',
  const = 'const',
  let = 'let',
  method = 'method',
  property = 'property',
  enum = 'enum',
  namespace = 'namespace',
  module = 'module',
  arrowFunction = 'arrowFunction',
  decorator = 'decorator',
  import = 'import',
  export = 'export',
}

export const symbols = sqliteTable(
  'symbols',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    kind: customEnum<SymbolKind>('kind').notNull(),
    file_path: text()
      .notNull()
      .references(() => files.path, { onDelete: 'cascade' }),
    line: integer().notNull(),
    column: integer().notNull(),
    end_line: integer(),
    end_column: integer(),
    signature: text(),
    parameters_json: text(),
    return_type: text(),
    docstring: text(),
    parent_id: text(),
    decorator: text(),
    exported: integer({ mode: 'boolean' }).default(false),
    language: text().notNull(),
  },
  (table) => [
    index('idx_symbols_name').on(table.name),
    index('idx_symbols_kind').on(table.kind),
    index('idx_symbols_file').on(table.file_path),
    index('idx_symbols_decorator').on(table.decorator),
  ],
)

export type IndexedSymbol = {
  Insert: typeof symbols.$inferInsert
  Select: typeof symbols.$inferSelect
  Update: Partial<typeof symbols.$inferSelect>
}
