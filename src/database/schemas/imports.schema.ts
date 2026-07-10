import { sqliteTable, text, index, integer } from 'drizzle-orm/sqlite-core'
import { files } from './files.schema'
import { customEnum } from './common.schema'

export enum ResolvedKind {
  Source = 'source',
  Package = 'package',
  BuiltIn = 'builtin',
  StdLib = 'stdlib',
  Declaration = 'declaration',
  Asset = 'asset',
  Unresolved = 'unresolved',
}

export enum ResolutionSource {
  Bun = 'bun',
  Typescript = 'typescript',
  PythonImportlib = 'python-importlib',
  PythonStatic = 'python-static',
  LSP = 'lsp',
  Manual = 'manual',
  Unresolved = 'unresolved',
}

export enum ImportKind {
  Default = 'default',
  Named = 'named',
  Namespace = 'namespace',
  SideEffect = 'side-effect',
  TypeOnly = 'type-only',
  Unresolved = 'unresolved',
}

export enum EdgeKind {
  Import = 'import',
  ReExport = 're-export',
  ExportAll = 'export-all',
}

export const imports = sqliteTable(
  'imports',
  {
    id: text().primaryKey(),
    file_path: text()
      .notNull()
      .references(() => files.path, { onDelete: 'cascade' }),
    sourceModule: text().notNull(),
    importedNames: text({ mode: 'json' }).$type<string[]>(),
    resolvedPath: text(),
    resolvedKind: customEnum<ResolvedKind>('resolvedKind').notNull(),
    isExternal: integer({ mode: 'boolean' }).default(false),
    isRuntimeDependency: integer({ mode: 'boolean' }).default(false),
    importKind: customEnum<ImportKind>('importKind').notNull(),
    resolutionSource:
      customEnum<ResolutionSource>('resolutionSource').notNull(),
    edgeKind: customEnum<EdgeKind>('edgeKind').notNull(),
    confidence: integer().default(0),
    reason: text(),
  },
  (table) => [
    index('idx_imports_file').on(table.file_path),
    index('idx_imports_source_module').on(table.sourceModule),
  ],
)

export type IndexedImport = {
  Insert: typeof imports.$inferInsert
  Select: typeof imports.$inferSelect
  Update: Partial<typeof imports.$inferSelect>
}

export type ImportResolutionResult = Omit<
  IndexedImport['Select'],
  'id' | 'file_path'
>
