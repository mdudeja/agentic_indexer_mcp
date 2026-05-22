import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import type { SymbolKind } from '../../config/types'

/** Registers a tool to enable searching for symbols (functions, classes, etc.) by name or pattern, supporting filtering by kind, file path, and result limits. */
export function registerSearchSymbolsTool(server: McpServer) {
  server.registerTool(
    'search_symbols',
    {
      title: 'Search Symbols',
      description:
        'Search for symbols (functions, classes, etc.) by name or pattern',
      inputSchema: z.object({
        query: z.string().describe('The search pattern (supports * wildcard)'),
        kind: z
          .string()
          .optional()
          .describe(
            'Filter by kind (function, class, interface, type, variable, method, enum)',
          ),
        file_pattern: z
          .string()
          .optional()
          .describe('Filter by file path pattern (supports * wildcard)'),
        limit: z
          .number()
          .optional()
          .describe('Maximum number of results to return (default: 20)'),
      }),
    },
    async ({ query, kind, file_pattern, limit }) => {
      const store = IndexerDB.getInstance()
      try {
        const results = await store.searchSymbols(
          query as string,
          kind as SymbolKind | 'all',
          file_pattern as string | undefined,
          limit as number | undefined,
        )

        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No symbols found matching query: ${query}`,
              },
            ],
          }
        }

        const formattedResults = results
          .map((r) => {
            let str = `[${r.kind.toUpperCase()}] ${r.name} in ${r.file_path}:${r.line + 1}`
            if (r.signature) {
              str += `\n  Signature: ${r.signature}`
            }
            if (r.docstring) {
              str += `\n  Doc: ${r.docstring.replace(/\n/g, '. ')}`
            }
            if (r.parameters_json) {
              try {
                const params = JSON.parse(r.parameters_json)
                str += `\n  Parameters: ${params
                  .map((p: any) => `${p.name}: ${p.type}`)
                  .join(', ')}`
              } catch (e) {
                // Ignore JSON parsing errors
              }
            }
            if (r.return_type) {
              str += `\n  Returns: ${r.return_type}`
            }
            return str
          })
          .join('\n\n')

        return {
          content: [{ type: 'text', text: formattedResults }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error searching symbols: ${err}` }],
          isError: true,
        }
      }
    },
  )
}
