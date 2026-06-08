import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerTools } from './tools/index'
import { logInfo } from '../utils/logger'
import { AppStateManager } from 'src/state'
import { Watcher } from '../watcher/Watcher'
import { IndexerDB } from 'src/database/IndexerDB'

/** Starts an MCP (Message Communication Protocol) server to handle indexing of workspaces. This server connects using standard input/output transport, logs its operation, and monitors file system changes within the specified root directory if available. */
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

  AppStateManager.getInstance().setItem('server', server)

  logInfo(
    `[indexer] MCP server running on stdio for ${AppStateManager.getInstance().getItem('root')}`,
  )

  const cwd = AppStateManager.getInstance().getItem('root')
  if (cwd) {
    const watcher = new Watcher(cwd as string)
    AppStateManager.getInstance().setItem('watcher', watcher)
    watcher.start()
  }
}

/** Stops the MCP server and the file system watcher if they are running. This function ensures that all resources are properly released and logs the shutdown process. */
export async function stopMcpServer() {
  const server = AppStateManager.getInstance().getItem('server')
  if (!server) {
    logInfo(`[indexer] No MCP server found to stop`)
  } else {
    await server.close()
    logInfo(`[indexer] MCP server stopped`)
  }

  const watcher = AppStateManager.getInstance().getItem('watcher')
  if (!watcher) {
    logInfo(`[indexer] No file system watcher found to stop`)
  } else {
    watcher.stop()
    logInfo(`[indexer] File system watcher stopped`)
  }

  const db = IndexerDB.getInstance()
  db.close()
  logInfo(`[indexer] Database connection closed`)
}
