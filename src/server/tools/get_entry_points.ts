import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { eq, and, isNull, inArray, SQL } from 'drizzle-orm'
import * as schema from '../../database/schemas'
import type { SymbolKind } from '../../database/schemas'
import { AppStateManager } from 'src/state'
import { updateUsage } from 'src/utils/updateUsage'

const ALL_KINDS = [
  'function',
  'class',
  'const',
  'arrowFunction',
  'interface',
  'type',
] as const

/** Registers a tool to list all top-level exported symbols, optionally filtered to true external entry points. */
export function registerGetEntryPointsTool(server: McpServer) {
  server.registerTool(
    'get_entry_points',
    {
      title: 'Get Entry Points',
      description:
        'List top-level exported symbols — the public API surface of the codebase. ' +
        '\n\n' +
        'TWO MODES: ' +
        'Default (`only_unreferenced=false`): returns ALL exported top-level symbols — useful for understanding what a module exposes to callers. ' +
        '`only_unreferenced=true`: filters to exports that no other indexed file imports — these are the true program entry points ' +
        '(CLI commands, HTTP route handlers, top-level scripts, plugin registrations). This is the mode to use when asked "where does execution start?". ' +
        '\n\n' +
        'CAVEAT: Symbols consumed via namespace imports (`import * as X` then `X.foo()`) will appear unreferenced even if they are used. ' +
        'Treat `only_unreferenced` results as strong candidates, not definitive. ' +
        '\n\n' +
        'OUTPUT FORMAT: Grouped by file, each symbol shows kind, name, line number, signature, and first line of docstring. ' +
        '\n\n' +
        'COMPARE WITH OTHER TOOLS: `get_file_details` shows all symbols in one specific file (not just exports). ' +
        '`get_codebase_map` shows the same exports but aggregated by directory with dependency-layer context.',
      inputSchema: z.object({
        kind: z
          .array(z.enum(ALL_KINDS))
          .optional()
          .describe(
            'Filter by symbol kinds (default: function, class, const, arrowFunction, interface, type)',
          ),
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
          const TEST_RE =
            AppStateManager.getInstance()
              .getItem('config')
              ?.testFilePatterns.map((p) => {
                if (p instanceof RegExp) return p
                if (typeof p === 'string') return new RegExp(p)
                return null
              })
              .filter((p): p is RegExp => p !== null) ?? null
          results = results.filter(
            (s) => !TEST_RE?.some((re) => re.test(s.file_path)),
          )
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

        const output = header + '\n' + sections.join('\n\n')

        //usage computation
        await updateUsage('get_entry_points', [], output.length)
        return {
          content: [{ type: 'text', text: output }],
        }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Error getting entry points: ${err}` },
          ],
          isError: true,
        }
      }
    },
  )
}
