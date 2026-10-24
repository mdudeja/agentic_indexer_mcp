import { describe, beforeAll, test } from 'bun:test'
import { registerSearchCodebaseTool } from '../src/server/tools/search_codebase'
import { registerReadCodeTool } from '../src/server/tools/read_code'
import { registerInspectSymbolTool } from '../src/server/tools/inspect_symbol'
import { registerTraceCodeGraphTool } from '../src/server/tools/trace_code_graph'
import { registerAnalyzeChangeImpactTool } from '../src/server/tools/analyze_change_impact'
import { registerExploreArchitectureTool } from '../src/server/tools/explore_architecture'
import { registerAnalyzeQualityTool } from '../src/server/tools/analyze_quality'
import { registerInspectImportsTool } from '../src/server/tools/inspect_imports'
import { registerAuditIndexTool } from '../src/server/tools/audit_index'

/** A mock server implementation for MCP, providing functionality to register tools with specified schemas and handler functions. */
class MockMcpServer {
  tools = new Map<string, { schema: any; handler: Function }>()

  /** Registers a new tool with a specified name, schema, and handler function. */
  registerTool(name: string, schema: any, handler: Function) {
    /** Validates and processes input arguments using a specified schema before passing them to the handler function. */
    const wrappedHandler = async (args: any) => {
      const parsedArgs =
        schema.inputSchema && typeof schema.inputSchema.parse === 'function'
          ? schema.inputSchema.parse(args)
          : args
      return handler(parsedArgs)
    }
    this.tools.set(name, { schema, handler: wrappedHandler })
  }
}

describe.skip('Debug Tools', () => {
  let mockServer: MockMcpServer

  beforeAll(async () => {
    mockServer = new MockMcpServer()
    registerSearchCodebaseTool(mockServer as any)
    registerReadCodeTool(mockServer as any)
    registerInspectSymbolTool(mockServer as any)
    registerTraceCodeGraphTool(mockServer as any)
    registerAnalyzeChangeImpactTool(mockServer as any)
    registerExploreArchitectureTool(mockServer as any)
    registerAnalyzeQualityTool(mockServer as any)
    registerInspectImportsTool(mockServer as any)
    registerAuditIndexTool(mockServer as any)
  })

  test('runner', async () => {
    const tool = mockServer.tools.get('read_code')
    if (!tool) {
      throw new Error('Tool not found')
    }

    const resp = await tool.handler({
      name: 'notifyLog',
      file_path_or_name: 'src/server/respond.ts',
      mode: 'summary',
    })

    console.log(resp)
  })
})
