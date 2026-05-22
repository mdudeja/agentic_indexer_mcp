import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { eq, and, isNull, isNotNull, like } from 'drizzle-orm'
import * as schema from '../../database/schemas'

/** Registers a tool to produce a top-down architectural map of the codebase grouped by directory. */
export function registerGetCodebaseMapTool(server: McpServer) {
  server.registerTool(
    'get_codebase_map',
    {
      title: 'Get Codebase Map',
      description:
        'Produce a top-down architectural overview of the codebase: files grouped by directory, key exported symbols per group, and cross-group dependency relationships. Use this first when orienting yourself in an unfamiliar codebase.',
      inputSchema: z.object({
        depth: z
          .number()
          .default(1)
          .describe(
            'Directory depth to group files by (1 = top-level dirs, 2 = two levels deep). Default 1.',
          ),
      }),
    },
    async ({ depth }) => {
      const store = IndexerDB.getInstance()
      try {
        const db = store.getDb()
        const maxDepth = (depth as number) ?? 1

        const allFiles = await store.getAllFiles()
        if (allFiles.length === 0) {
          return {
            content: [{ type: 'text', text: 'No files indexed yet.' }],
          }
        }

        // Group files by path prefix at given depth
        const groups = new Map<string, string[]>()
        for (const file of allFiles) {
          const parts = file.path.split('/')
          const prefix =
            parts.length <= maxDepth ? '(root)' : parts.slice(0, maxDepth).join('/')
          const list = groups.get(prefix) ?? []
          list.push(file.path)
          groups.set(prefix, list)
        }

        const sections: string[] = []

        for (const [prefix, filePaths] of groups) {
          const fileCount = filePaths.length

          // Key exported symbols with docstrings for this group
          const pattern = prefix === '(root)' ? '%' : `${prefix}/%`
          const keySymbols = await db
            .select({
              name: schema.symbols.name,
              kind: schema.symbols.kind,
              file_path: schema.symbols.file_path,
              line: schema.symbols.line,
              docstring: schema.symbols.docstring,
            })
            .from(schema.symbols)
            .where(
              and(
                eq(schema.symbols.exported, true),
                isNull(schema.symbols.parent_id),
                isNotNull(schema.symbols.docstring),
                like(schema.symbols.file_path, pattern),
              ),
            )
            .limit(5)

          // Cross-group dependencies: which other groups does this group import from?
          const importedBy = new Set<string>()
          const importers = await store.getImporters(`%${prefix.replace('(root)', '')}%`)
          for (const imp of importers) {
            const importerParts = imp.file_path.split('/')
            const importerGroup =
              importerParts.length <= maxDepth
                ? '(root)'
                : importerParts.slice(0, maxDepth).join('/')
            if (importerGroup !== prefix) {
              importedBy.add(importerGroup)
            }
          }

          const symbolLines =
            keySymbols.length > 0
              ? keySymbols
                  .map(
                    (s) =>
                      `  - ${s.name} [${s.kind}] (${s.file_path}:${s.line + 1}): ${s.docstring!.split('\n')[0]}`,
                  )
                  .join('\n')
              : '  (no documented exports)'

          const depsLine =
            importedBy.size > 0
              ? `Imported by: ${[...importedBy].join(', ')} (heuristic — based on module path patterns)`
              : 'Imported by: (none detected)'

          sections.push(
            `## ${prefix} (${fileCount} file${fileCount !== 1 ? 's' : ''})\nKey exports:\n${symbolLines}\n${depsLine}`,
          )
        }

        const header = `Codebase Map (depth=${maxDepth}, ${groups.size} group${groups.size !== 1 ? 's' : ''}, ${allFiles.length} files total)\n`
        return {
          content: [{ type: 'text', text: header + '\n' + sections.join('\n\n') }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error building codebase map: ${err}` }],
          isError: true,
        }
      }
    },
  )
}
