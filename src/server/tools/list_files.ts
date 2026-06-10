import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { like, eq, and, SQL } from 'drizzle-orm'
import * as schema from '../../database/schemas'
import { updateUsage } from 'src/utils/updateUsage'

/** Registers a tool that allows users to list all indexed files in the workspace, optionally filtered by file path pattern or language. */
export function registerListFilesTool(server: McpServer) {
  server.registerTool(
    'list_files',
    {
      title: 'List Indexed Files',
      description:
        'List files that have been indexed in the workspace, with optional filtering by path pattern and language. ' +
        '\n\n' +
        'WHEN TO USE: To confirm a file is in the index before calling other tools on it. ' +
        'To discover what languages are indexed. ' +
        'To enumerate files under a specific directory (use `pattern: "src/server/*"`). ' +
        'To check when a file was last indexed (output includes `indexed_at` timestamp). ' +
        '\n\n' +
        'USE OTHER TOOLS INSTEAD WHEN: You want the symbols inside a file — use `get_file_details`. ' +
        'You want to find files related to a symbol — use `find_symbol_references` or `search_symbols`. ' +
        '\n\n' +
        'OUTPUT FORMAT: One line per file — path, language in brackets, and indexed_at timestamp. ' +
        'Results are capped at the `limit` (default 100); increase it if you expect more files.',
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
      const store = IndexerDB.getInstance()
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

        const ouputText = `Found ${results.length} files:\n\n${output}`

        //usage computation
        const filePaths = results.map((f) => f.path)
        await updateUsage('list_files', filePaths, output.length, true)

        return {
          content: [
            {
              type: 'text',
              text: ouputText,
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
