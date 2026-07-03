import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { join } from 'path'
import { readFileSync, existsSync } from 'fs'
import { AppStateManager } from 'src/state/index.ts'
import { updateUsage } from 'src/utils/updateUsage.ts'

/** Registers a tool to read arbitrary line ranges from files in the workspace. */
export function registerReadFileSnippetTool(server: McpServer) {
  server.registerTool(
    'read_file_snippet',
    {
      title: 'Read File Snippet',
      description:
        'Read a specific range of lines (1-based, inclusive) from a file. ' +
        'Use this to view raw source segments, configs, imports, or boilerplate code that are not bound to named symbols.',
      inputSchema: z.object({
        file_path: z
          .string()
          .describe('File path relative to the workspace root'),
        start_line: z
          .number()
          .describe('1-based start line number (inclusive)'),
        end_line: z.number().describe('1-based end line number (inclusive)'),
      }),
    },
    async ({ file_path, start_line, end_line }) => {
      const cwd = AppStateManager.getInstance().getItem('root') ?? process.cwd()
      const absPath = join(cwd, file_path as string)

      try {
        if (!existsSync(absPath)) {
          return {
            content: [{ type: 'text', text: `File not found: ${file_path}` }],
            isError: true,
          }
        }

        const content = readFileSync(absPath, 'utf8')
        const lines = content.split('\n')

        const start = Math.max(1, start_line as number) - 1
        const end = Math.min(lines.length, end_line as number)

        if (start > end) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid line range: ${start_line} to ${end_line}. Total lines in file: ${lines.length}.`,
              },
            ],
            isError: true,
          }
        }

        const snippet = lines.slice(start, end).join('\n')
        const ext = (file_path as string).split('.').pop() || ''
        const exntToLangMap =
          AppStateManager.getInstance().getItem('config')?.extnToLangMap ?? {}
        const output = `Lines ${start_line}-${end_line} of ${file_path}:\n\`\`\`${exntToLangMap[ext] || ext}\n${snippet}\n\`\`\``

        await updateUsage(
          'read_file_snippet',
          [file_path as string],
          output.length,
        )

        return {
          content: [{ type: 'text', text: output }],
        }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Error reading file snippet: ${err}` },
          ],
          isError: true,
        }
      }
    },
  )
}
