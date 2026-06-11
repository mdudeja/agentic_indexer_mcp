import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB.ts'
import { updateUsage } from 'src/utils/updateUsage.ts'

/** Registers a tool to trace potential exceptions bubble-up paths downstream of a starting symbol. */
export function registerTraceErrorFlowTool(server: McpServer) {
  server.registerTool(
    'trace_error_flow',
    {
      title: 'Trace Error Flow',
      description:
        'Trace and list all exceptions that can bubble up from a specific function or method, ' +
        'including exceptions thrown directly within the function and those propagating from downstream sub-calls. ' +
        '\n\n' +
        'WHEN TO USE: When writing try/catch blocks, verifying function safety, or investigating potential crash points ' +
        'in the call tree of a given starting symbol.',
      inputSchema: z.object({
        symbol_name: z.string().describe('The name of the function or method to analyze (e.g. "parseConfig")'),
      }),
    },
    async ({ symbol_name }) => {
      const store = IndexerDB.getInstance()

      try {
        const results = await store.getExceptionsBubbleUp(symbol_name as string)

        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No exceptions found throwing or bubbling up from: ${symbol_name}`,
              },
            ],
          }
        }

        const direct = results.filter((r) => r.symbol_name.toLowerCase() === (symbol_name as string).toLowerCase())
        const indirect = results.filter((r) => r.symbol_name.toLowerCase() !== (symbol_name as string).toLowerCase())

        let output = `Error flow analysis for "${symbol_name}":\n\n`

        if (direct.length > 0) {
          output += `### Direct Exceptions (thrown inside "${symbol_name}"):\n`
          output += direct.map((r) => `  - Throws \`${r.exception_type}\` at ${r.file_path}:${r.line + 1}`).join('\n')
          output += '\n\n'
        }

        if (indirect.length > 0) {
          output += `### Bubbled Up Exceptions (propagating from downstream sub-calls):\n`
          // Group by symbol throwing it for better readability
          const groups = new Map<string, Array<{ exception_type: string; file_path: string; line: number }>>()
          for (const r of indirect) {
            const list = groups.get(r.symbol_name) ?? []
            list.push(r)
            groups.set(r.symbol_name, list)
          }

          for (const [subName, excList] of groups) {
            output += `  * From calling \`${subName}\`:\n`
            output += excList.map((r) => `    - Throws \`${r.exception_type}\` at ${r.file_path}:${r.line + 1}`).join('\n')
            output += '\n'
          }
        }

        const filePaths = new Set(results.map((r) => r.file_path))
        await updateUsage('trace_error_flow', Array.from(filePaths), output.length)

        return {
          content: [{ type: 'text', text: output }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error tracing exception flow: ${err}` }],
          isError: true,
        }
      }
    },
  )
}
