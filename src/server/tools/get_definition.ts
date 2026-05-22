import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { join } from 'path'
import { readFileSync } from 'fs'
import { AppStateManager } from 'src/state'
import type { IndexedSymbol } from 'src/database/schemas/symbols.schema'
import type { IndexedFile } from 'src/database/schemas'

/** Registers a tool to retrieve the full source code definition of a symbol, allowing agents to fetch the definition using either a symbol ID or a combination of name and file path. */
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
          .describe(
            'The name of the symbol (used if symbol_id is omitted). Supports partial matches, but must be combined with file_path for disambiguation.',
          ),
        file_path_or_name: z
          .string()
          .optional()
          .describe(
            'File name or File path relative to workspace root. Supports partial file name or file path matches. (required if using name).',
          ),
      }),
    },
    async ({ symbol_id, name, file_path_or_name }) => {
      const store = IndexerDB.getInstance()
      try {
        let fileRecord: IndexedFile['Select'] | null = null
        let symbol: IndexedSymbol['Select'] | null = null

        if (symbol_id) {
          symbol = await store.getDefinition(symbol_id as string)
        } else if (name && file_path_or_name) {
          const files = await store.getFileByPartialNameOrPath(
            file_path_or_name ?? '',
          )
          if (files.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: `No file found matching: ${file_path_or_name}`,
                },
              ],
            }
          }
          if (files.length > 1) {
            const fileList = files.map((f) => `  - ${f.path}`).join('\n')
            return {
              content: [
                {
                  type: 'text',
                  text: `Multiple files found matching "${file_path_or_name}". Please specify a more specific path or use the file ID:\n${fileList}`,
                },
              ],
            }
          }
          fileRecord = files[0] ?? null
          symbol = await store.getDefinitionByName(
            name as string,
            fileRecord!.path,
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
          symbol.file_path,
        )
        const fileContent = readFileSync(absPath, 'utf-8')
        const lines = fileContent.split('\n')

        let defText = ''
        if (symbol.end_line != null) {
          // Tree-sitter is 0-indexed for rows, so inclusive slice might be + 1
          defText = lines.slice(symbol.line, symbol.end_line + 1).join('\n')
        } else {
          // Fallback if we don't have end_line
          defText =
            lines.slice(symbol.line, symbol.line + 10).join('\n') +
            '\n// ... (truncated)'
        }

        const output = `Definition of ${symbol.name} in ${symbol.file_path}:\n\n\`\`\`${symbol.language}\n${defText}\n\`\`\``

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
