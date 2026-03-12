import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { IndexerDB } from '../../database/IndexerDB'
import { registerSearchSymbolsTool } from './search_symbols'
import { registerGetFileSummaryTool } from './get_file_summary'
import { registerListFilesTool } from './list_files'
import { registerGetDefinitionTool } from './get_definition'

export function registerTools(
  server: McpServer,
  store: IndexerDB,
  cwd: string,
) {
  registerSearchSymbolsTool(server, store)
  registerGetFileSummaryTool(server, store)
  registerListFilesTool(server, store)
  registerGetDefinitionTool(server, store, cwd)
}
