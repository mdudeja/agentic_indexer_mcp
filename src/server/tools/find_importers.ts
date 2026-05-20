import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'

export function registerFindImportersTool(server: McpServer) {
  server.registerTool(
    'find_importers',
    {
      title: 'Find Importers',
      description: 'Find all files that import a specific module',
      inputSchema: z.object({
        module_name: z
          .string()
          .describe(
            'The name of the module or file path pattern to find importers for. Supports * wildcards.',
          ),
      }),
    },
    async ({ module_name }) => {
      const store = IndexerDB.getInstance()
      try {
        const importers = await store.getImporters(module_name as string)
        if (importers.length === 0) {
          return {
            content: [
              { type: 'text', text: `No importers found for ${module_name}` },
            ],
          }
        }

        const uniquePaths = [...new Set(importers.map((i) => i.file_path))]
        const text = uniquePaths.map((p) => `- ${p}`).join('\n')
        return {
          content: [
            { type: 'text', text: `Files importing ${module_name}:\n${text}` },
          ],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error finding importers: ${err}` }],
          isError: true,
        }
      }
    },
  )
}
