import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { files } from './files.schema'
import { symbols } from './symbols.schema'
import { customEnum } from './common.schema'

export enum CallKind {
  FunctionCall = 'function_call',
  MethodCall = 'method_call',
  ConstructorCall = 'constructor_call',
  DecoratorCall = 'decorator_call',
  SuperCall = 'super_call',
  DynamicCall = 'dynamic_call',
  Unknown = 'unknown',
}

export const call_sites = sqliteTable(
  'call_sites',
  {
    id: text().primaryKey(),
    caller_id: text()
      .notNull()
      .references(() => symbols.id, { onDelete: 'cascade' }),
    caller_file_path: text()
      .notNull()
      .references(() => files.path, { onDelete: 'cascade' }),
    language_name: text().notNull(),
    call_text: text().notNull(),
    callee_expression: text().notNull(),
    callee_name: text().notNull(),
    callee_base: text(),
    callee_property: text(),
    call_kind: customEnum<CallKind>('call_kind')
      .notNull()
      .default(CallKind.Unknown),
    call_line: integer(),
    call_column: integer(),
    end_line: integer(),
    end_column: integer(),
    docstring: text(),

    // True for handlers[name](), obj[method](), getattr(obj, name)(), etc.
    is_dynamic: integer({ mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    index('idx_call_sites_caller').on(table.caller_id),
    index('idx_call_sites_file').on(table.caller_file_path),
    index('idx_call_sites_name').on(table.callee_name),
    index('idx_call_sites_kind').on(table.call_kind),
    index('idx_call_sites_location').on(
      table.caller_file_path,
      table.call_line,
      table.call_column,
    ),
  ],
)

export type IndexedCallSite = {
  Insert: typeof call_sites.$inferInsert
  Select: typeof call_sites.$inferSelect
  Update: Partial<typeof call_sites.$inferSelect>
}
