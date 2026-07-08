import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { like } from 'drizzle-orm'
import * as schema from '../../database/schemas'
import { updateUsage } from 'src/utils/updateUsage'

/** Registers a tool that gets all imports for a given file. */
export function registerGetImportsForFileTool(server: McpServer) {
  server.registerTool(
    'get_imports_for_file',
    {
      title: 'Get Imports For File',
      description:
        'Retrieves all imports associated with a given file path. ' +
        '\n\n' +
        'WHEN TO USE: Use this to discover dependencies of a specific file.',
      inputSchema: z.object({
        filePath: z
          .string()
          .describe('The path of the file to get imports for'),
        limit: z
          .number()
          .optional()
          .describe('Maximum number of results to return (default: 100)'),
      }),
    },
    async ({ filePath, limit }) => {
      const store = IndexerDB.getInstance()
      try {
        const db = store.getDb()

        const results = await db
          .select()
          .from(schema.imports)
          .where(like(schema.imports.file_path, `%${filePath}%`))
          .limit((limit as number) || 100)

        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No imports found for the specified file.',
              },
            ],
          }
        }

        const output = results
          .map((i) => {
            return `- [${i.id}] import ${i.imported_name || '*'} from '${i.module_path}'`
          })
          .join('\n')

        const outputText = `Found ${results.length} imports in ${filePath}:\n\n${output}`

        //usage computation
        await updateUsage(
          'get_imports_for_file',
          [filePath],
          outputText.length,
          true,
        )

        return {
          content: [
            {
              type: 'text',
              text: outputText,
            },
          ],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error getting imports: ${err}` }],
          isError: true,
        }
      }
    },
  )
}
