import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { join } from 'path'
import { homedir } from 'os'
import { AppStateManager } from 'src/state/index.ts'
import { TsMorphEnhancer } from '../../indexer/enhancers/TsMorphEnhancer.ts'
import { GenericLspEnhancer } from '../../indexer/enhancers/GenericLspEnhancer.ts'
import { updateUsage } from 'src/utils/updateUsage.ts'
import type { Enhancer } from '../../indexer/steps/s2_Enhancer.ts'

/** Registers a tool to get the inferred or explicit type of an identifier at a specific line and column. */
export function registerGetTypeAtLocationTool(server: McpServer) {
  server.registerTool(
    'get_type_at_location',
    {
      title: 'Get Type at Location',
      description:
        "Retrieve the fully-resolved type of a variable, parameter, property, or expression " +
        'at a specific line and column (1-based index) in a file. ' +
        '\n\n' +
        'WHEN TO USE: When you need to understand the type context of a variable, especially if it uses ' +
        'complex type inference, unions, generics, or is from an external library, to diagnose type errors ' +
        'or understand API usage at a specific line. ' +
        '\n\n' +
        'INPUT FORMAT: `line` and `column` must be 1-based editor coordinates.',
      inputSchema: z.object({
        file_path: z.string().describe('The file path relative to the workspace root'),
        line: z.number().describe('The 1-based line number'),
        column: z.number().describe('The 1-based column number'),
      }),
    },
    async ({ file_path, line, column }) => {
      const cwd = AppStateManager.getInstance().getItem('root') ?? process.cwd()
      const absPath = join(cwd, file_path as string)
      const ext = (file_path as string).split('.').pop() || ''

      try {
        let enhancer: Enhancer | null = null

        if (ext === 'ts' || ext === 'tsx') {
          enhancer = AppStateManager.getInstance().getItem('tsMorphEnhancer') as TsMorphEnhancer | undefined ?? null
          if (!enhancer) {
            const tsEnhancer = new TsMorphEnhancer(cwd)
            const initialized = await tsEnhancer.init()
            if (initialized) {
              enhancer = tsEnhancer
              AppStateManager.getInstance().setItem('tsMorphEnhancer', tsEnhancer)
            }
          }
        } else {
          // Check for configured or default LSPs for other languages
          const lspConfigs: Record<string, { cmd: string; langId: string; stateKey: any }> = {
            py: {
              cmd: process.env.LSP_PYTHON_PATH || `${homedir()}/.local/share/nvim/mason/bin/pyright-langserver`,
              langId: 'python',
              stateKey: 'pyLspEnhancer',
            },
            lua: {
              cmd: process.env.LSP_LUA_PATH || `${homedir()}/.local/share/nvim/mason/bin/lua-language-server`,
              langId: 'lua',
              stateKey: 'luaLspEnhancer',
            },
            go: {
              cmd: process.env.LSP_GO_PATH || 'gopls',
              langId: 'go',
              stateKey: 'goLspEnhancer',
            },
          }

          const config = lspConfigs[ext]
          if (config) {
            enhancer = AppStateManager.getInstance().getItem(config.stateKey) as GenericLspEnhancer | undefined ?? null
            if (!enhancer) {
              const lspEnhancer = new GenericLspEnhancer(cwd, config.cmd, config.langId)
              const initialized = await lspEnhancer.init()
              if (initialized) {
                enhancer = lspEnhancer
                AppStateManager.getInstance().setItem(config.stateKey, lspEnhancer)
              }
            }
          }
        }

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
        const typeStr = await enhancer.getTypeAtLocation(absPath, (line as number) - 1, (column as number) - 1)

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

        const output = `Type at ${file_path}:${line}:${column}:\n\`\`\`${ext === 'ts' || ext === 'tsx' ? 'typescript' : ext}\n${typeStr}\n\`\`\``

        // usage computation
        await updateUsage('get_type_at_location', [file_path as string], output.length)

        return {
          content: [{ type: 'text', text: output }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error getting type at location: ${err}` }],
          isError: true,
        }
      }
    },
  )
}
