import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { simpleGit } from 'simple-git'
import { IndexerDB } from '../../database/IndexerDB.ts'
import { AppStateManager } from 'src/state/index.ts'
import { updateUsage } from 'src/utils/updateUsage.ts'
import type { IndexedSymbol } from 'src/database/schemas/symbols.schema.ts'

/** Registers a tool to retrieve the git commit history affecting a specific symbol's line ranges. */
export function registerGetSymbolHistoryTool(server: McpServer) {
  server.registerTool(
    'get_symbol_history',
    {
      title: 'Get Symbol History',
      description:
        'Retrieve the git commit history and changes for a specific code symbol. ' +
        'Uses the symbol line bounds and queries git history to find commits affecting those lines. ' +
        '\n\n' +
        'WHEN TO USE: When you need to understand the evolution of a function or class, find out who has modified it, ' +
        'or read commit messages explaining why certain changes were introduced.',
      inputSchema: z.object({
        symbol_id: z
          .string()
          .optional()
          .describe('The unique ID of the symbol (preferred)'),
        name: z
          .string()
          .optional()
          .describe(
            'The name of the symbol (required if symbol_id is omitted)',
          ),
        file_path_or_name: z
          .string()
          .optional()
          .describe('File path or partial file name (required if using name)'),
        include_diff: z
          .boolean()
          .optional()
          .describe(
            'Whether to include the line diff for each commit (default: false)',
          ),
      }),
    },
    async ({ symbol_id, name, file_path_or_name, include_diff }) => {
      const store = IndexerDB.getInstance()
      const cwd = AppStateManager.getInstance().getItem('root') ?? process.cwd()

      try {
        let symbol: IndexedSymbol['Select'] | null = null

        if (symbol_id) {
          symbol = await store.symbols.getDefinition(symbol_id as string)
        } else if (name && file_path_or_name) {
          const files =
            await store.files.getByPartialNameOrPath(file_path_or_name)
          if (files.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: `File not found matching: ${file_path_or_name}`,
                },
              ],
              isError: true,
            }
          }
          if (files.length > 1) {
            const fileList = files.map((f) => `  - ${f.path}`).join('\n')
            return {
              content: [
                {
                  type: 'text',
                  text: `Multiple files found matching "${file_path_or_name}". Please be more specific:\n${fileList}`,
                },
              ],
              isError: true,
            }
          }
          symbol = await store.symbols.getDefinitionByName(
            name as string,
            files[0]!.path,
          )
        } else {
          throw new Error(
            'Must provide either symbol_id, or both name and file_path_or_name',
          )
        }

        if (!symbol) {
          return {
            content: [{ type: 'text', text: 'Symbol not found in index' }],
            isError: true,
          }
        }

        if (symbol.end_line == null) {
          return {
            content: [
              {
                type: 'text',
                text: `Symbol ${symbol.name} does not have line bounds in the database, cannot query git history.`,
              },
            ],
            isError: true,
          }
        }

        const git = simpleGit(cwd)
        const gitArgs = [
          'log',
          '-L',
          `${symbol.line + 1},${symbol.end_line + 1}:${symbol.file_path}`,
        ]

        if (!include_diff) {
          gitArgs.push('--no-patch')
        }

        // Run raw log to preserve raw output format of -L command
        const rawLog = await git.raw(gitArgs)

        let output = `Git history for symbol "${symbol.name}" in ${symbol.file_path} (Lines ${symbol.line + 1}-${symbol.end_line + 1}):\n\n`

        if (!rawLog || rawLog.trim().length === 0) {
          output += 'No commit history found for these lines.'
        } else {
          output += rawLog
        }

        await updateUsage(
          'get_symbol_history',
          [symbol.file_path],
          output.length,
        )

        return {
          content: [{ type: 'text', text: output }],
        }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Error fetching symbol history: ${err}` },
          ],
          isError: true,
        }
      }
    },
  )
}
