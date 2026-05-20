import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerTools } from './tools/index'
import { logInfo } from '../utils/logger'
import { AppStateManager } from 'src/state'
import { Watcher } from '../watcher/Watcher'

/** Starts the workspace-indexer MCP server using stdio transport, registers tools, and initiates a file watcher for the workspace root. */
export async function startMcpServer() {
  const server = new McpServer({
    name: 'workspace-indexer',
    version: '0.1.0',
  })

  // Register all tools with the server
  registerTools(server)

  // Start the server using stdio transport
  const transport = new StdioServerTransport()
  await server.connect(transport)

  logInfo(
    `[indexer] MCP server running on stdio for ${AppStateManager.getInstance().getItem('root')}`,
  )

  const cwd = AppStateManager.getInstance().getItem('root')
  if (cwd) {
    const watcher = new Watcher(cwd as string)
    watcher.start()
  }
}
