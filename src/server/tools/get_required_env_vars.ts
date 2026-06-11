import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB.ts'
import { updateUsage } from 'src/utils/updateUsage.ts'

/** Registers a tool to trace env variable reads downstream of a starting symbol. */
export function registerGetRequiredEnvVarsTool(server: McpServer) {
  server.registerTool(
    'get_required_env_vars',
    {
      title: 'Get Required Env Vars',
      description:
        'Trace and list all environment variables (e.g. `process.env.XYZ` or `os.environ["XYZ"]`) accessed by a ' +
        'function, method, or downstream inside its call tree. ' +
        '\n\n' +
        'WHEN TO USE: When deploying, setting up configuration, debugging environment-dependent bugs, or documenting ' +
        'module requirements for a given entry point.',
      inputSchema: z.object({
        symbol_name: z.string().describe('The name of the function or method to analyze (e.g. "startServer")'),
      }),
    },
    async ({ symbol_name }) => {
      const store = IndexerDB.getInstance()

      try {
        const results = await store.getEnvVarsBubbleUp(symbol_name as string)

        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No environment variable reads found in the call tree starting from: ${symbol_name}`,
              },
            ],
          }
        }

        const direct = results.filter((r) => r.symbol_name.toLowerCase() === (symbol_name as string).toLowerCase())
        const indirect = results.filter((r) => r.symbol_name.toLowerCase() !== (symbol_name as string).toLowerCase())

        let output = `Environment variables accessed downstream of "${symbol_name}":\n\n`

        if (direct.length > 0) {
          output += `### Directly Accessed (inside "${symbol_name}"):\n`
          output += direct.map((r) => `  - \`${r.env_var_name}\` at ${r.file_path}:${r.line + 1}`).join('\n')
          output += '\n\n'
        }

        if (indirect.length > 0) {
          output += `### Downstream Accessed (propagating from downstream sub-calls):\n`
          const groups = new Map<string, Array<{ env_var_name: string; file_path: string; line: number }>>()
          for (const r of indirect) {
            const list = groups.get(r.symbol_name) ?? []
            list.push(r)
            groups.set(r.symbol_name, list)
          }

          for (const [subName, envList] of groups) {
            output += `  * From calling \`${subName}\`:\n`
            output += envList.map((r) => `    - \`${r.env_var_name}\` at ${r.file_path}:${r.line + 1}`).join('\n')
            output += '\n'
          }
        }

        const filePaths = new Set(results.map((r) => r.file_path))
        await updateUsage('get_required_env_vars', Array.from(filePaths), output.length)

        return {
          content: [{ type: 'text', text: output }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error tracing environment variables: ${err}` }],
          isError: true,
        }
      }
    },
  )
}
