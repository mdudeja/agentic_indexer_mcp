import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { eq, and, isNull, inArray, SQL } from 'drizzle-orm'
import * as schema from '../../database/schemas'
import type { SymbolKind } from '../../database/schemas'

const TEST_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$|__tests__\//

const ALL_KINDS = ['function', 'class', 'const', 'arrowFunction', 'interface', 'type'] as const

/** Registers a tool to list all top-level exported symbols, optionally filtered to true external entry points. */
export function registerGetEntryPointsTool(server: McpServer) {
  server.registerTool(
    'get_entry_points',
    {
      title: 'Get Entry Points',
      description:
        "List all top-level exported symbols in the codebase — the public API surface. Use this to understand a module's external interface or to identify where execution can begin. Set only_unreferenced=true to find symbols not imported by any other indexed file (true external entry points).",
      inputSchema: z.object({
        kind: z
          .array(z.enum(ALL_KINDS))
          .optional()
          .describe('Filter by symbol kinds (default: function, class, const, arrowFunction, interface, type)'),
        exclude_tests: z
          .boolean()
          .default(true)
          .describe('Exclude symbols from test files (default true)'),
        only_unreferenced: z
          .boolean()
          .default(false)
          .describe(
            'When true, only show exports not imported by any other indexed file. Note: symbols used via namespace imports (import * as X) may appear unreferenced.',
          ),
      }),
    },
    async ({ kind, exclude_tests, only_unreferenced }) => {
      const store = IndexerDB.getInstance()
      try {
        const db = store.getDb()
        const kinds = (kind as string[] | undefined) ?? [...ALL_KINDS]

        const conditions: SQL[] = [
          eq(schema.symbols.exported, true),
          isNull(schema.symbols.parent_id),
          inArray(schema.symbols.kind, kinds as SymbolKind[]),
        ]

        let results = await db
          .select()
          .from(schema.symbols)
          .where(and(...conditions))
          .orderBy(schema.symbols.file_path, schema.symbols.line)

        if (exclude_tests) {
          results = results.filter((s) => !TEST_RE.test(s.file_path))
        }

        if (only_unreferenced) {
          const allImportedNames = await db
            .select({ name: schema.imports.imported_name })
            .from(schema.imports)
          const importedNameSet = new Set(
            allImportedNames.map((i) => i.name).filter(Boolean),
          )
          results = results.filter((s) => !importedNameSet.has(s.name))
        }

        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No exported entry points found${only_unreferenced ? ' (all exports are imported by other files)' : ''}.`,
              },
            ],
          }
        }

        // Group by file
        const byFile = new Map<string, typeof results>()
        for (const sym of results) {
          const group = byFile.get(sym.file_path) ?? []
          group.push(sym)
          byFile.set(sym.file_path, group)
        }

        const sections = [...byFile.entries()].map(([filePath, syms]) => {
          const symLines = syms.map((s) => {
            let line = `  [${s.kind}] ${s.name} (line ${s.line + 1})`
            if (s.signature) line += ` → ${s.signature}`
            if (s.docstring) line += `\n    Doc: ${s.docstring.split('\n')[0]}`
            return line
          })
          return `${filePath}\n${symLines.join('\n')}`
        })

        const flags = [
          exclude_tests ? 'excluding tests' : 'including tests',
          only_unreferenced ? 'unreferenced only' : null,
        ]
          .filter(Boolean)
          .join(', ')

        const header = `Entry Points (${flags})\nTotal: ${results.length} symbol${results.length !== 1 ? 's' : ''} across ${byFile.size} file${byFile.size !== 1 ? 's' : ''}\n`
        return {
          content: [{ type: 'text', text: header + '\n' + sections.join('\n\n') }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error getting entry points: ${err}` }],
          isError: true,
        }
      }
    },
  )
}
