import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import type { SymbolKind } from '../../config/types'
import { updateUsage } from 'src/utils/updateUsage'

/** Registers a tool to enable searching for symbols (functions, classes, etc.) by name or pattern, supporting filtering by kind, file path, and result limits. */
export function registerSearchSymbolsTool(server: McpServer) {
  server.registerTool(
    'search_symbols',
    {
      title: 'Search Symbols',
      description:
        'Search for symbols (functions, classes, methods, interfaces, types, variables) by name or pattern across all indexed files. ' +
        "This is the primary lookup tool when you know (part of) a symbol's name. " +
        '\n\n' +
        'WHEN TO USE: As the first step when investigating a named symbol. ' +
        'Returns signature, docstring, parameters, and return type — enough to understand a symbol without reading the full source. ' +
        'The `id` field in each result can be passed directly to `get_definition` to fetch the full implementation. ' +
        '\n\n' +
        'USE OTHER TOOLS WHEN: ' +
        'You want structure-based matching (same return type, same param count) — use `find_similar_patterns`. ' +
        'You want all symbols in a specific file — use `get_file_details`. ' +
        'You want to know who calls a symbol — use `find_symbol_references` or `trace_call_graph`. ' +
        '\n\n' +
        'TIPS: `*` wildcard is supported (e.g. `get*` matches all symbols starting with "get"). ' +
        'Use `file_pattern` to narrow to a subsystem. ' +
        'Use `kind` to restrict to a specific symbol type when the name is common.',
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
        const results = await store.symbols.search(
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
            if (r.inheritence && r.inheritence.length) {
              str += '\n  Inheritence: '
              for (const item of r.inheritence) {
                str += `\n  ${item.inheritence_type} ${item.inherits_from_name} (${item.inherits_from_id ? `id=${item.inherits_from_id}, ` : `imports_id=${item.inherits_from_imports_id}`})`
              }
            }
            return str
          })
          .join('\n\n')

        // usage computation
        const filePaths = new Set(results.map((r) => r.file_path))
        await updateUsage(
          'search_symbols',
          Array.from(filePaths),
          results.length,
        )
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
