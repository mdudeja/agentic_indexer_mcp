import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'

/** Registers a tool to the MCP server that identifies the direct callers and affected files for a specified symbol to determine the potential impact of a change. */
export function registerGetBlastRadiusTool(server: McpServer) {
  server.registerTool(
    'get_blast_radius',
    {
      title: 'Get Blast Radius',
      description:
        'Find callers and dependents (files and symbols) that might break if you change a symbol.',
      inputSchema: z.object({
        symbol_name: z
          .string()
          .describe('The exact name of the symbol being modified'),
      }),
    },
    async ({ symbol_name }) => {
      const store = IndexerDB.getInstance()
      try {
        const callers = await store.getCallers(symbol_name as string)
        if (callers.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No direct callers found for ${symbol_name}`,
              },
            ],
          }
        }

        const uniquePaths = [...new Set(callers.map((c) => c.callerFile))]
        const text = uniquePaths.map((p) => `- File: ${p}`).join('\n')
        return {
          content: [
            {
              type: 'text',
              text: `Blast Radius for ${symbol_name} (Direct Callers):\n${text}\nEnsure testing covers these paths.`,
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
