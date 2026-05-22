import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerSearchSymbolsTool } from './search_symbols'
import { registerGetFileSummaryTool } from './get_file_summary'
import { registerListFilesTool } from './list_files'
import { registerGetDefinitionTool } from './get_definition'
import { registerFindImportersTool } from './find_importers'
import { registerGetBlastRadiusTool } from './get_blast_radius'
import { registerPlanRefactoringTool } from './plan_refactoring'

/** Registers various tools on the given server to provide functionality for code analysis and refactoring. */
export function registerTools(server: McpServer) {
  registerSearchSymbolsTool(server)
  registerGetFileSummaryTool(server)
  registerListFilesTool(server)
  registerGetDefinitionTool(server)
  registerFindImportersTool(server)
  registerGetBlastRadiusTool(server)
  registerPlanRefactoringTool(server)
}
