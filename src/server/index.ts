import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { IndexerDB } from '../database/IndexerDB'
import { registerTools } from './tools/index'
import { logInfo } from '../utils/logger'

export async function startMcpServer(cwd: string) {
  // Initialize symbol store
  // Make sure we connect to the project's specific .agentic/index/symbols.sqlite
  const dbPath = `${cwd}/.agentic/index/symbols.sqlite`
  const store = IndexerDB.getInstance(dbPath)
  await store.init()

  const server = new McpServer({
    name: 'workspace-indexer',
    version: '0.1.0',
  })

  // Register all tools with the server, passing in the store instance
  registerTools(server, store, cwd)

  // Start the server using stdio transport
  const transport = new StdioServerTransport()
  await server.connect(transport)

  logInfo(`[indexer] MCP server running on stdio for ${cwd}`)
}
