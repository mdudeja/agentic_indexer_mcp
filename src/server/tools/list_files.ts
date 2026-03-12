import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { IndexerDB } from '../../database/IndexerDB'
import { like, eq, and, SQL } from 'drizzle-orm'
import * as schema from '../../database/schemas'

export function registerListFilesTool(server: McpServer, store: IndexerDB) {
  server.registerTool(
    'list_files',
    {
      title: 'List Indexed Files',
      description:
        'List all files that have been indexed in the workspace, with optional filtering by path pattern and language',
      inputSchema: z.object({
        pattern: z
          .string()
          .optional()
          .describe('Filter by file path pattern (supports * wildcard)'),
        language: z
          .string()
          .optional()
          .describe('Filter by language name (e.g. typescript, python)'),
        limit: z
          .number()
          .optional()
          .describe('Maximum number of results to return (default: 100)'),
      }),
    },
    async ({ pattern, language, limit }) => {
      try {
        const db = store.getDb()
        const conditions: SQL[] = []

        if (pattern) {
          const sqlPattern = (pattern as string).replace(/\*/g, '%')
          conditions.push(like(schema.files.path, sqlPattern))
        }

        if (language) {
          conditions.push(eq(schema.files.language, language as string))
        }

        const query = db.select().from(schema.files).$dynamic()

        const results = await (
          conditions.length > 0 ? query.where(and(...conditions)) : query
        ).limit((limit as number) || 100)

        if (results.length === 0) {
          return {
            content: [
              { type: 'text', text: 'No files found matching criteria.' },
            ],
          }
        }

        const output = results
          .map((f) => {
            const date = new Date(f.indexed_at).toISOString()
            return `- ${f.path} [${f.language}] (indexed: ${date})`
          })
          .join('\n')

        return {
          content: [
            {
              type: 'text',
              text: `Found ${results.length} files:\n\n${output}`,
            },
          ],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error listing files: ${err}` }],
          isError: true,
        }
      }
    },
  )
}
