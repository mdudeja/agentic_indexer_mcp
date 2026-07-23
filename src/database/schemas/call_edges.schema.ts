import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { call_sites } from './call_sites.schema'
import { imports } from './imports.schema'
import { symbols } from './symbols.schema'
import { customEnum } from './common.schema'

export enum CallTargetKind {
  ProjectSymbol = 'project_symbol',
  Import = 'import',
  Builtin = 'builtin',
  Dynamic = 'dynamic',
  Unresolved = 'unresolved',
}

export enum CallResolutionSource {
  SameFile = 'same_file',
  SameClass = 'same_class',
  SameClassProperty = 'same_class_property',
  SourceImport = 'source_import',
  ExternalImport = 'external_import',
  BuiltinList = 'builtin_list',
  LspDefinition = 'lsp_definition',
  LspHover = 'lsp_hover',
  DynamicPattern = 'dynamic_pattern',
  Unresolved = 'unresolved',
}

export const call_edges = sqliteTable(
  'call_edges',
  {
    id: text().primaryKey(),
    call_site_id: text()
      .notNull()
      .references(() => call_sites.id, { onDelete: 'cascade' }),
    caller_id: text()
      .notNull()
      .references(() => symbols.id, { onDelete: 'cascade' }),
    target_kind: customEnum<CallTargetKind>('target_kind')
      .notNull()
      .default(CallTargetKind.Unresolved),
    callee_id: text().references(() => symbols.id, {
      onDelete: 'set null',
    }),
    imports_id: text().references(() => imports.id, {
      onDelete: 'set null',
    }),
    resolution_source: customEnum<CallResolutionSource>('resolution_source')
      .notNull()
      .default(CallResolutionSource.Unresolved),
    confidence: integer().notNull().default(0),
    reason: text(),
  },
  (table) => [
    index('idx_call_edges_site').on(table.call_site_id),
    index('idx_call_edges_caller').on(table.caller_id),
    index('idx_call_edges_target_kind').on(table.target_kind),
    index('idx_call_edges_callee').on(table.callee_id),
    index('idx_call_edges_import').on(table.imports_id),
    index('idx_call_edges_resolution_source').on(table.resolution_source),
  ],
)

export type IndexedCallEdge = {
  Insert: typeof call_edges.$inferInsert
  Select: typeof call_edges.$inferSelect
  Update: Partial<typeof call_edges.$inferSelect>
}
