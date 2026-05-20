import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'

/** Registers the get_file_summary tool with the MCP server to provide an aggregated summary of all symbols, including functions, classes, and variables, defined within a specified file. */
export function registerGetFileSummaryTool(server: McpServer) {
  server.registerTool(
    'get_file_summary',
    {
      title: 'Get File Summary',
      description:
        'Get an aggregated summary of all symbols (functions, classes, variables) defined in a file',
      inputSchema: z.object({
        file_path: z
          .string()
          .describe('The file path relative to the workspace root'),
      }),
    },
    async ({ file_path }) => {
      const store = IndexerDB.getInstance()
      try {
        const results = await store.getFileSummary(file_path)

        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No symbols found or file not indexed: ${file_path}`,
              },
            ],
          }
        }

        // Group by kind
        const grouped = results.reduce(
          (acc, sym) => {
            if (!acc[sym.kind]) acc[sym.kind] = []
            acc[sym.kind]!.push(sym)
            return acc
          },
          {} as Record<string, typeof results>,
        )

        let output = `Summary for ${file_path}:\n\n`

        for (const [kind, symbols] of Object.entries(grouped)) {
          output += `## ${kind.toUpperCase()}S\n`
          for (const sym of symbols) {
            output += `- ${sym.name} (line ${sym.line + 1})`
            if (sym.exported) output += ' [exported]'
            output += '\n'
          }
          output += '\n'
        }

        return {
          content: [{ type: 'text', text: output }],
        }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Error getting file summary: ${err}` },
          ],
          isError: true,
        }
      }
    },
  )
}
