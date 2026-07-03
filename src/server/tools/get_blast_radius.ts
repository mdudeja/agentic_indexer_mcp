import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { updateUsage } from 'src/utils/updateUsage'

/** Registers a tool to find callers of a symbol up to a configurable depth, showing the blast radius of a potential change. */
export function registerGetBlastRadiusTool(server: McpServer) {
  server.registerTool(
    'get_blast_radius',
    {
      title: 'Get Blast Radius',
      description:
        'Find every caller that might break if you change a symbol — including transitive callers up the full call chain (BFS). ' +
        'Returns a flat, deduplicated list of all callers with file:line references. ' +
        '\n\n' +
        'WHEN TO USE: Before modifying a symbol, to assess risk. ' +
        'A long list means the change is high-blast-radius and needs careful testing. ' +
        'An empty result means the symbol is either an entry point or safe to change in isolation. ' +
        '\n\n' +
        'COMPARE WITH OTHER TOOLS: ' +
        '`find_symbol_references` gives a flat 1-hop lookup (direct callers and imports only). ' +
        '`trace_call_graph(direction=inbound)` gives the same BFS traversal but as an indented tree, ' +
        'which is better when you need to understand the structure of who calls whom. ' +
        'Use `get_blast_radius` when you just want the count and list of all affected callers quickly. ' +
        '\n\n' +
        'The output ends with a reminder to check test coverage for the affected paths.',
      inputSchema: z.object({
        symbol_name: z
          .string()
          .describe('The exact name of the symbol being modified'),
        file_pattern: z
          .string()
          .optional()
          .describe('Filter by file path pattern (supports * wildcard)'),
      }),
    },
    async ({ symbol_name, file_pattern }) => {
      const store = IndexerDB.getInstance()
      try {
        const name = symbol_name as string
        const startSymbols = await store.symbols.search(
          name,
          'all',
          file_pattern as string | undefined,
        )

        if (startSymbols.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Symbol '${name}' not found in codebase.`,
              },
            ],
          }
        }

        if (startSymbols.length > 1 && !file_pattern) {
          return {
            content: [
              {
                type: 'text',
                text: `Multiple symbols found with name '${name}'. Please provide a file_pattern to disambiguate.`,
              },
            ],
          }
        }

        const startSymbol = startSymbols[0]

        // BFS over inbound call graph
        const visited = new Set<string>()
        const allCallers: Array<{
          callerFile: string
          callerName: string
          line: number
        }> = []
        const queue = new Set<string>([startSymbol!.name])

        while (queue.size > 0) {
          const current = queue.values().next().value
          if (!current) break
          queue.delete(current)
          if (visited.has(current)) continue
          visited.add(current)

          const callers = await store.calls.getCallersNested(current)
          for (const c of callers) {
            allCallers.push(c)
            queue.add(c.callerName)
          }
        }

        if (allCallers.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No callers found for '${name}'. Safe to change or may be an entry point.`,
              },
            ],
          }
        }

        const lines = allCallers.map(
          (c) => `  - ${c.callerName} (${c.callerFile}:${c.line + 1})`,
        )

        const dedupedLines = Array.from(new Set(lines)).sort()

        const output = `Blast radius for '${name}' (${dedupedLines.length} caller${dedupedLines.length !== 1 ? 's' : ''})\n${dedupedLines.join('\n')}\n\nEnsure testing covers these paths. Use trace_call_graph(direction=inbound) for a full traversal tree.`

        // usage computation
        const filePaths = (
          await store.symbols.getSymbolsByNames(Array.from(visited))
        ).map((s) => s.file_path)
        const uniqueFilePaths = Array.from(new Set(filePaths))
        await updateUsage('get_blast_radius', uniqueFilePaths, output.length)

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Error finding blast radius: ${err}` },
          ],
          isError: true,
        }
      }
    },
  )
}
