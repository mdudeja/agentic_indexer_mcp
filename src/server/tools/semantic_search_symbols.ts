import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB.ts'
import type { SymbolKind } from '../../config/types.ts'
import { updateUsage } from 'src/utils/updateUsage.ts'
import { OllamaEmbeddingGenerator } from 'src/indexer/embedders/OllamaEmbeddingGenerator.ts'

/** Registers a tool to enable semantic and hybrid searching for symbols across the codebase. */
export function registerSemanticSearchSymbolsTool(server: McpServer) {
  server.registerTool(
    'semantic_search_symbols',
    {
      title: 'Semantic Search Symbols',
      description:
        'Search for symbols (functions, classes, methods, etc.) semantically using natural language queries (e.g., "authentication", "logging", "file storage"). ' +
        'This tool uses hybrid search, combining vector embeddings of symbol signatures/docstrings with text-based keyword matching on symbol names. ' +
        '\n\n' +
        'WHEN TO USE: When you want to find code related to a concept, intent, or topic but do not know the exact symbol names. ' +
        '\n\n' +
        'TIPS: Use descriptive natural language queries. You can also filter by `kind` or `file_pattern` to narrow down results.',
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            'The semantic or natural language query (e.g. "password hashing")',
          ),
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
      const embedder = new OllamaEmbeddingGenerator()

      try {
        // Generate query embedding (gracefully falls back to text-only if Ollama is down)
        const embedding = await embedder.getEmbedding(query)
        if (!embedding) {
          console.warn(
            '[Semantic Search] Ollama embedding generation failed. Falling back to text-only search.',
          )
        }

        const results = await store.symbols.searchSymbolsHybrid(
          query as string,
          embedding,
          kind as SymbolKind | 'all',
          file_pattern as string | undefined,
          limit as number | undefined,
        )

        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No symbols found matching query: "${query}"`,
              },
            ],
          }
        }

        const formattedResults = results
          .map(({ symbol: r, score }) => {
            let str = `[${r.kind.toUpperCase()}] ${r.name} in ${r.file_path}:${r.line + 1} (Score: ${score.toFixed(4)})`
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
        const filePaths = new Set(results.map((r) => r.symbol.file_path))
        await updateUsage(
          'semantic_search_symbols',
          Array.from(filePaths),
          results.length,
        )
        return {
          content: [{ type: 'text', text: formattedResults }],
        }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Error running semantic search: ${err}` },
          ],
          isError: true,
        }
      }
    },
  )
}
