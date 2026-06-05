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
        depth: z
          .number()
          .default(1)
          .describe(
            'How many caller levels to traverse (default 1 = direct callers only)',
          ),
      }),
    },
    async ({ symbol_name, depth }) => {
      const store = IndexerDB.getInstance()
      try {
        const name = symbol_name as string
        const maxDepth = (depth as number) ?? 1

        // BFS over inbound call graph
        const visited = new Set<string>()
        const allCallers: Array<{
          callerFile: string
          callerName: string
          line: number
          depth: number
        }> = []
        const queue: Array<{ name: string; depth: number }> = [
          { name, depth: 0 },
        ]

        while (queue.length > 0) {
          const current = queue.shift()!
          if (visited.has(current.name) || current.depth >= maxDepth) continue
          visited.add(current.name)

          const callers = await store.getCallers(current.name)
          for (const c of callers) {
            allCallers.push({ ...c, depth: current.depth + 1 })
            if (current.depth + 1 < maxDepth) {
              queue.push({ name: c.callerName, depth: current.depth + 1 })
            }
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
          (c) =>
            `  - ${c.callerName} (${c.callerFile}:${c.line + 1})${maxDepth > 1 ? ` [depth ${c.depth}]` : ''}`,
        )

        return {
          content: [
            {
              type: 'text',
              text: `Blast radius for '${name}' (${allCallers.length} caller${allCallers.length !== 1 ? 's' : ''}, depth=${maxDepth}):\n${lines.join('\n')}\n\nEnsure testing covers these paths. Use trace_call_graph(direction=inbound) for a full traversal tree.`,
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
