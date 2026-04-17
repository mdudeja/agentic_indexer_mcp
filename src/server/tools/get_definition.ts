import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { join } from 'path'
import { readFileSync } from 'fs'
import { AppStateManager } from 'src/state'

export function registerGetDefinitionTool(server: McpServer) {
  server.registerTool(
    'get_definition',
    {
      title: 'Get Symbol Definition',
      description: 'Get the full source code definition of a symbol',
      inputSchema: z.object({
        symbol_id: z
          .string()
          .optional()
          .describe('The unique ID of the symbol (preferred if known)'),
        name: z
          .string()
          .optional()
          .describe('The name of the symbol (used if symbol_id is omitted)'),
        file_path: z
          .string()
          .optional()
          .describe(
            'The file path where the symbol is defined (required if using name)',
          ),
      }),
    },
    async ({ symbol_id, name, file_path }) => {
      const store = IndexerDB.getInstance()
      try {
        let symbol

        if (symbol_id) {
          symbol = await store.getDefinition(symbol_id as string)
        } else if (name && file_path) {
          symbol = await store.getDefinitionByName(
            name as string,
            file_path as string,
          )
        } else {
          throw new Error(
            'Must provide either symbol_id or both name and file_path',
          )
        }

        if (!symbol) {
          return {
            content: [{ type: 'text', text: `Symbol not found` }],
          }
        }

        const absPath = join(
          AppStateManager.getInstance().getItem('root') ?? '',
          symbol.filePath,
        )
        const fileContent = readFileSync(absPath, 'utf-8')
        const lines = fileContent.split('\n')

        let defText = ''
        if (symbol.endLine != null) {
          // Tree-sitter is 0-indexed for rows, so inclusive slice might be + 1
          defText = lines.slice(symbol.line, symbol.endLine + 1).join('\n')
        } else {
          // Fallback if we don't have end_line
          defText =
            lines.slice(symbol.line, symbol.line + 10).join('\n') +
            '\n// ... (truncated)'
        }

        const ext = symbol.filePath.split('.').pop()
        const output = `Definition of ${symbol.name} in ${symbol.filePath}:\n\n\`\`\`${ext}\n${defText}\n\`\`\``

        return {
          content: [{ type: 'text', text: output }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error getting definition: ${err}` }],
          isError: true,
        }
      }
    },
  )
}
