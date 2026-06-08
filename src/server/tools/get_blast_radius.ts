import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'

/** Registers a tool to find callers of a symbol up to a configurable depth, showing the blast radius of a potential change. */
export function registerGetBlastRadiusTool(server: McpServer) {
  server.registerTool(
    'get_blast_radius',
    {
      title: 'Get Blast Radius',
      description:
        'Find callers and dependents that might break if you change a symbol. For deeper traversal use trace_call_graph with direction=inbound.',
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
        const startSymbols = await store.searchSymbols(
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
        const queue: Array<{ name: string }> = [{ name: startSymbol!.name }]

        while (queue.length > 0) {
          const current = queue.shift()!
          if (visited.has(current.name)) continue
          visited.add(current.name)

          const callers = await store.getCallersNested(current.name)
          for (const c of callers) {
            allCallers.push(c)
            queue.push({ name: c.callerName })
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

        return {
          content: [
            {
              type: 'text',
              text: `Blast radius for '${name}' (${allCallers.length} caller${allCallers.length !== 1 ? 's' : ''})\n${lines.join('\n')}\n\nEnsure testing covers these paths. Use trace_call_graph(direction=inbound) for a full traversal tree.`,
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
