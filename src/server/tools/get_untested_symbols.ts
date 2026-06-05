import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { eq, and, isNull, inArray } from 'drizzle-orm'
import * as schema from '../../database/schemas'
import { AppStateManager } from 'src/state'
import { SymbolKind } from '../../database/schemas'
import { allCallableKinds } from 'src/utils/allCallableKinds'

/** Registers a tool to identify exported callable symbols that have no evidence of test coverage. */
export async function registerGetUntestedSymbolsTool(server: McpServer) {
  const CALLABLE_KINDS = [...(await allCallableKinds()), SymbolKind.class]
  server.registerTool(
    'get_untested_symbols',
    {
      title: 'Get Untested Symbols',
      description:
        "Find exported callable symbols (functions, classes) that have no test coverage evidence. Coverage is determined by checking whether the symbol's file is imported by any test file (1-hop import analysis). Symbols in files that test files never import directly are considered untested. Note: transitive imports and dynamic requires are not traced — this is a conservative 1-hop heuristic.",
      inputSchema: z.object({
        kind: z
          .array(z.enum(CALLABLE_KINDS))
          .optional()
          .describe(
            'Symbol kinds to check (default: function, arrowFunction, method, class).',
          ),
        limit: z
          .number()
          .default(50)
          .describe('Maximum number of symbols to return (default 50).'),
      }),
    },
    async ({ kind, limit }) => {
      const store = IndexerDB.getInstance()
      try {
        const db = store.getDb()
        const kinds = (kind as string[] | undefined) ?? [...CALLABLE_KINDS]
        const maxLimit = (limit as number) ?? 50

        // Resolve test file patterns from config
        const TEST_RE =
          AppStateManager.getInstance()
            .getItem('config')
            ?.testFilePatterns.map((p) => {
              if (p instanceof RegExp) return p
              if (typeof p === 'string') return new RegExp(p)
              return null
            })
            .filter((p): p is RegExp => p !== null) ?? null

        // Get all indexed files
        const allFiles = await store.getAllFiles()
        const testFilePaths = new Set(
          allFiles
            .filter((f) => TEST_RE?.some((re) => re.test(f.path)))
            .map((f) => f.path),
        )

        if (testFilePaths.size === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No test files found in the indexed workspace. Cannot determine test coverage.',
              },
            ],
          }
        }

        // Get all module_paths imported by test files
        const testImports = await db
          .select({ module_path: schema.imports.module_path })
          .from(schema.imports)
          .where(inArray(schema.imports.file_path, [...testFilePaths]))
        const testCoveredPaths = new Set(testImports.map((i) => i.module_path))

        // All non-test file paths
        const allFilePaths = allFiles.map((f) => f.path)
        const nonTestPaths = allFilePaths.filter(
          (p) => !testFilePaths.has(p) && !testCoveredPaths.has(p),
        )

        if (nonTestPaths.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'All non-test files are imported by test files. No untested symbols found.',
              },
            ],
          }
        }

        // Get exported callable symbols in untested files
        const untestedSymbols = await db
          .select()
          .from(schema.symbols)
          .where(
            and(
              eq(schema.symbols.exported, true),
              isNull(schema.symbols.parent_id),
              inArray(schema.symbols.kind, kinds as SymbolKind[]),
              inArray(schema.symbols.file_path, nonTestPaths),
            ),
          )
          .orderBy(schema.symbols.file_path, schema.symbols.line)
          .limit(maxLimit)

        if (untestedSymbols.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No untested exported symbols found.',
              },
            ],
          }
        }

        // Group by file
        const byFile = new Map<string, typeof untestedSymbols>()
        for (const s of untestedSymbols) {
          const list = byFile.get(s.file_path) ?? []
          list.push(s)
          byFile.set(s.file_path, list)
        }

        const lines: string[] = [
          `Found ${untestedSymbols.length} untested exported symbol${untestedSymbols.length !== 1 ? 's' : ''} in ${byFile.size} file${byFile.size !== 1 ? 's' : ''}`,
          `(${testFilePaths.size} test files cover ${testCoveredPaths.size} source files directly)\n`,
        ]

        for (const [file, symbols] of byFile) {
          lines.push(file)
          for (const s of symbols) {
            lines.push(`  ${s.kind} ${s.name} (line ${s.line + 1})`)
          }
          lines.push('')
        }

        lines.push(
          'Note: 1-hop import analysis only. Transitive imports are not traced.',
        )

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
        }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Error finding untested symbols: ${err}` },
          ],
          isError: true,
        }
      }
    },
  )
}
