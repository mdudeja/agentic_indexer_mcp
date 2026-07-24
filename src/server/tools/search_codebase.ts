import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolResult } from './index'
import { IndexerDB } from 'src/database/IndexerDB'
import {
  SymbolKind,
  type IndexedSymbol,
} from 'src/database/schemas/symbols.schema'
import { isPathLike } from 'src/utils/paths'
import { z } from 'zod'
import { logError, logWarning } from 'src/utils/logger'
import type { EmbeddingGenerator } from 'src/indexer/steps/s4_EmbeddingGenerator'
import { AppStateManager } from 'src/state'
import { embedderNameToClass } from 'src/indexer/IndexPipeline'
import type { IndexedFile } from 'src/database/schemas'
import { updateUsage } from 'src/utils/updateUsage'

const ALL_KINDS = Object.keys(SymbolKind) as (keyof typeof SymbolKind)[]
enum SEARCH_MODE {
  symbol = 'symbol',
  semantic = 'semantic',
  file_compact = 'file_compact',
  file_detailed = 'file_detailed',
  auto = 'auto',
}

function assignMode(query: string): SEARCH_MODE {
  if (isPathLike(query)) {
    return SEARCH_MODE.file_compact
  }

  const numberOfWords = query.trim().split(/\s+/).length
  if (numberOfWords > 3) {
    return SEARCH_MODE.semantic
  }

  return SEARCH_MODE.symbol
}

async function searchSymbols(
  store: IndexerDB,
  query: string,
  kind?: (keyof typeof SymbolKind)[],
  language?: string,
  limit?: number,
  file_pattern?: string,
): Promise<ToolResult> {
  try {
    const results = await store.symbols.search(
      query as string,
      kind as SymbolKind[] | 'all',
      file_pattern as string | undefined,
      language as string | undefined,
      limit as number | undefined,
    )

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No symbols found matching the query.',
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

    await updateUsage(
      'search_symbols',
      Array.from(new Set(results.map((r) => r.file_path))),
      results.length,
    )

    return {
      content: [
        {
          type: 'text',
          text: formattedResults,
        },
      ],
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Error searching symbols: ${err}`,
        },
      ],
      isError: true,
    }
  }
}

async function searchFiles(
  store: IndexerDB,
  query: string,
  generateDetails: boolean,
  language?: string,
  limit?: number,
  file_pattern?: string,
): Promise<ToolResult> {
  try {
    const results = await store.files.search(
      query as string,
      language as string | undefined,
      limit as number | undefined,
      file_pattern as string | undefined,
    )

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No files found matching the query.',
          },
        ],
      }
    }

    const formattedResults = (
      await Promise.all(
        results.map(async (r) => {
          const responseText = `# ${r.path} [${r.language}] (indexed: ${new Date(r.indexed_at).toISOString()})`

          if (!generateDetails) {
            return responseText
          }

          const fileSymbols = await store.symbols.getForFile(r.path)
          const totalCount = fileSymbols.length
          const exportedCount = fileSymbols.filter((s) => s.exported).length

          const byKind = new Map<string, typeof fileSymbols>()
          for (const sym of fileSymbols) {
            const group = byKind.get(sym.kind) ?? []
            group.push(sym)
            byKind.set(sym.kind, group)
          }

          const sections: string[] = []
          for (const [kind, syms] of byKind) {
            const lines = syms.map((s) => {
              let line = `  - ${s.name} (line ${s.line + 1})`
              let params, return_type
              try {
                params = s.parameters_json
                  ? JSON.parse(s.parameters_json)
                  : null
                return_type = s.return_type ? s.return_type : null
              } catch (e) {
                // Ignore JSON parsing errors
              }

              if (s.exported) line += ' [exported]'
              if (s.signature && (!params || params.length === 0)) {
                line += `\n    Signature: ${s.signature}`
              }
              if (s.docstring)
                line += `\n    Doc: ${s.docstring.split('\n')[0]}`
              if (params && params.length > 0) {
                line += `\n    Parameters: ${params
                  .map((p: any) => `${p.name}: ${p.type}`)
                  .join(', ')}`
              }
              if (return_type) {
                line += `\n    Returns: ${return_type}`
              }
              if (s.inheritence && s.inheritence.length) {
                line += '\n  Inheritence: '
                for (const item of s.inheritence) {
                  line += `\n  ${item.inheritence_type} ${item.inherits_from_name} (${item.inherits_from_id ? `id=${item.inherits_from_id}, ` : `imports_id=${item.inherits_from_imports_id}`})`
                }
              }
              return line
            })
            sections.push(`## ${kind.toUpperCase()}\n${lines.join('\n')}`)
          }

          return `${responseText}\n\nTotal symbols: ${totalCount}, Exported symbols: ${exportedCount}\n\n${sections.join('\n\n')}`
        }),
      )
    ).join('\n')

    await updateUsage(
      'search_files',
      Array.from(new Set(results.map((r) => r.path))),
      results.length,
    )

    return {
      content: [
        {
          type: 'text',
          text: `Found ${results.length} files:\n\n${formattedResults}`,
        },
      ],
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Error searching files: ${err}`,
        },
      ],
      isError: true,
    }
  }
}

/** Attempts to load and initialize an embedding generator based on configuration settings. Returns null if configuration is missing or initialization fails. */
async function loadEmbedder(): Promise<EmbeddingGenerator | null> {
  const config = AppStateManager.getInstance().getItem('config')
  if (
    !config ||
    !config.embedder ||
    !config.embedder.enabled ||
    !config.embedder.provider
  ) {
    logError(
      '[Indexer] No embedder configuration found or embedder is not enabled. Skipping embedding generation.',
    )
    return null
  }
  const EmbedderClass = embedderNameToClass[config.embedder.provider]
  if (!EmbedderClass) {
    logError('[Indexer] Embedder not found. Skipping embedding generation.')
    return null
  }

  const embeddor = new EmbedderClass()
  const initialized = await embeddor.init()
  if (!initialized) {
    logError(
      `[Indexer] Failed to initialize ${embeddor.constructor.name}. Skipping embedding generation.`,
    )
    return null
  }

  return embeddor
}

async function semanticSearch(
  store: IndexerDB,
  query: string,
  kind?: (keyof typeof SymbolKind)[],
  language?: string,
  limit?: number,
  file_pattern?: string,
): Promise<ToolResult> {
  try {
    const embedder = await loadEmbedder()
    if (!embedder) {
      return {
        content: [
          {
            type: 'text',
            text: 'No embedder is configured or the embedder failed to initialize. Semantic search is unavailable.',
          },
        ],
        isError: true,
      }
    }

    // Generate query embedding (gracefully falls back to text-only if Ollama is down)
    const embedding = await embedder.getEmbedding(query)
    if (!embedding) {
      logWarning(
        '[Semantic Search] Ollama embedding generation failed. Falling back to text-only search.',
      )
      return searchSymbols(store, query, kind, language, limit, file_pattern)
    }

    const results = await store.symbols.searchSymbolsHybrid(
      query as string,
      embedding,
      kind as SymbolKind[] | 'all',
      file_pattern as string | undefined,
      language as string | undefined,
      limit as number | undefined,
    )

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No symbols found matching the query.',
          },
        ],
      }
    }

    const formattedResults = results
      .map(({ symbol: r, score }) => {
        let str = `[${r.kind.toUpperCase()}] ${r.name} in ${r.file_path}:${r.line + 1} (score: ${score.toFixed(4)})`
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

    await updateUsage(
      'semantic_search',
      Array.from(new Set(results.map((r) => r.symbol.file_path))),
      results.length,
    )

    return {
      content: [
        {
          type: 'text',
          text: formattedResults,
        },
      ],
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Error performing semantic search: ${err}`,
        },
      ],
      isError: true,
    }
  }
}

export function registerSearchCodebaseTool(server: McpServer) {
  server.registerTool(
    'search_codebase',
    {
      title: 'Search Codebase',
      description:
        'Searches the codebase for a given query and returns relevant results.',
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            'The search pattern (supports * wildcard for names and glob patterns for paths)',
          ),
        mode: z
          .enum(SEARCH_MODE)
          .optional()
          .describe(
            'Search mode: symbol, semantic, file, or auto (default: auto). Auto mode determines the best search mode based on the query. Semantic searches symbols',
          ),
        kind: z
          .array(z.enum(ALL_KINDS))
          .optional()
          .describe(
            'Optional filter for the kind of symbols to search for (e.g., function, class, variable)',
          ),
        language: z
          .string()
          .optional()
          .describe(
            'Optional filter for the programming language of the code elements',
          ),
        limit: z
          .number()
          .optional()
          .describe('Maximum number of results to return (default: 20)'),
        file_pattern: z
          .string()
          .optional()
          .describe(
            'Filter the results by file path pattern, e.g. a specific submodule (supports glob patterns)',
          ),
      }),
    },
    async ({ query, mode, kind, language, limit, file_pattern }) => {
      if (!query || query.trim() === '') {
        return {
          content: [
            {
              type: 'text',
              text: 'Query cannot be empty. Please provide a valid search query.',
            },
          ],
          isError: true,
        }
      }

      if (!mode) {
        mode = SEARCH_MODE.auto
      }

      if (mode === SEARCH_MODE.auto) {
        mode = assignMode(query)
      }

      const store = IndexerDB.getInstance()
      let result: ToolResult

      switch (mode) {
        case SEARCH_MODE.symbol:
          result = await searchSymbols(
            store,
            query,
            kind as (keyof typeof SymbolKind)[] | undefined,
            language,
            limit,
            file_pattern,
          )
          break
        case SEARCH_MODE.file_compact:
          result = await searchFiles(
            store,
            query,
            false,
            language,
            limit,
            file_pattern,
          )
          break
        case SEARCH_MODE.file_detailed:
          result = await searchFiles(
            store,
            query,
            true,
            language,
            limit,
            file_pattern,
          )
          break
        case SEARCH_MODE.semantic:
          result = await semanticSearch(
            store,
            query,
            kind as (keyof typeof SymbolKind)[] | undefined,
            language,
            limit,
            file_pattern,
          )
          break
        default:
          result = {
            content: [
              {
                type: 'text',
                text: `Unsupported search mode: ${mode}`,
              },
            ],
            isError: true,
          }
          break
      }

      return result
    },
  )
}
