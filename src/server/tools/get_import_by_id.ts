import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { eq } from 'drizzle-orm'
import * as schema from '../../database/schemas'
import { updateUsage } from 'src/utils/updateUsage'

/** Registers a tool that gets an import by its ID. */
export function registerGetImportByIdTool(server: McpServer) {
  server.registerTool(
    'get_import_by_id',
    {
      title: 'Get Import By ID',
      description: 'Retrieves details for a specific import by its unique ID.',
      inputSchema: z.object({
        id: z.string().describe('The unique ID of the import to retrieve'),
      }),
    },
    async ({ id }) => {
      const store = IndexerDB.getInstance()
      try {
        const db = store.getDb()

        const results = await db
          .select()
          .from(schema.imports)
          .where(eq(schema.imports.id, id as string))
          .limit(1)

        if (results.length === 0) {
          return {
            content: [
              { type: 'text', text: 'No import found with the specified ID.' },
            ],
          }
        }

        const importData = results[0]!
        const outputText = `Import ID: ${importData.id}\nFile: ${importData.file_path}\nModule: ${importData.module_path}\nImported Name: ${importData.imported_name || '*'}`

        //usage computation
        await updateUsage(
          'get_import_by_id',
          [importData.file_path],
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
          content: [
            { type: 'text', text: `Error getting import by ID: ${err}` },
          ],
          isError: true,
        }
      }
    },
  )
}
