import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export function registerPlanRefactoringTool(server: McpServer) {
  server.registerTool(
    'plan_refactoring',
    {
      title: 'Plan Refactoring',
      description: 'Generates a structured refactoring command instruction framework based on requested rename/extract operations.',
      inputSchema: z.object({
        target_symbol: z.string(),
        operation: z.enum(['rename', 'move', 'extract']),
        new_value: z.string().describe('The new name or location'),
      }),
    },
    async ({ target_symbol, operation, new_value }) => {
      return { 
        content: [{ 
          type: 'text', 
          text: `Refactoring Plan for ${target_symbol} (${operation} -> ${new_value}):\n1. Search and replace exact symbol occurrences.\n2. Update import paths if moving using find_importers.\n3. Validate dependencies using the get_blast_radius tool.`
        }] 
      }
    }
  )
}
