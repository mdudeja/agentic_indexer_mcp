import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { join } from 'path'
import { AppStateManager } from 'src/state/index.ts'
import { updateUsage } from 'src/utils/updateUsage.ts'

/** Registers a tool to get the inferred or explicit type of an identifier at a specific line and column. */
export function registerGetTypeAtLocationTool(server: McpServer) {
  server.registerTool(
    'get_type_at_location',
    {
      title: 'Get Type at Location',
      description:
        'Retrieve the fully-resolved type of a variable, parameter, property, or expression ' +
        'at a specific line and column (1-based index) in a file. ' +
        '\n\n' +
        'WHEN TO USE: When you need to understand the type context of a variable, especially if it uses ' +
        'complex type inference, unions, generics, or is from an external library, to diagnose type errors ' +
        'or understand API usage at a specific line. ' +
        '\n\n' +
        'INPUT FORMAT: `line` and `column` must be 1-based editor coordinates.',
      inputSchema: z.object({
        file_path: z
          .string()
          .describe('The file path relative to the workspace root'),
        line: z.number().describe('The 1-based line number'),
        column: z.number().describe('The 1-based column number'),
      }),
    },
    async ({ file_path, line, column }) => {
      const cwd = AppStateManager.getInstance().getItem('root') ?? process.cwd()
      const exntToLangMap =
        AppStateManager.getInstance().getItem('config')?.extnToLangMap ?? {}
      const absPath = join(cwd, file_path as string)
      const ext = (file_path as string).split('.').pop() || ''

      try {
        let enhancerMap = AppStateManager.getInstance().getItem('lspEnhancers')
        if (!enhancerMap) {
          return {
            content: [
              {
                type: 'text',
                text: 'LSP enhancers are not initialized. Please ensure the server is properly configured.',
              },
            ],
          }
        }

        let enhancer = enhancerMap.get(ext)

        if (!enhancer) {
          return {
            content: [
              {
                type: 'text',
                text: `Type hover is not supported or not initialized for .${ext} files.`,
              },
            ],
          }
        }

        // Convert 1-based editor coordinates to 0-based compiler coordinates
        const typeStr = await enhancer.getTypeAtLocation(
          absPath,
          (line as number) - 1,
          (column as number) - 1,
        )

        if (!typeStr) {
          return {
            content: [
              {
                type: 'text',
                text: `Could not resolve type at ${file_path}:${line}:${column}. Make sure you are pointing to a valid identifier.`,
              },
            ],
          }
        }

        const output = `Type at ${file_path}:${line}:${column}:\n\`\`\`${exntToLangMap[ext] || ext}\n${typeStr}\n\`\`\``

        // usage computation
        await updateUsage(
          'get_type_at_location',
          [file_path as string],
          output.length,
        )

        return {
          content: [{ type: 'text', text: output }],
        }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Error getting type at location: ${err}` },
          ],
          isError: true,
        }
      }
    },
  )
}
