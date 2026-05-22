import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { eq, and, like, not, SQL } from 'drizzle-orm'
import * as schema from '../../database/schemas'

/** Registers a tool to find symbols with structurally similar patterns (kind, return type, parameter count, decorator). */
export function registerFindSimilarPatternsTool(server: McpServer) {
  server.registerTool(
    'find_similar_patterns',
    {
      title: 'Find Similar Patterns',
      description:
        'Find symbols that follow the same structural pattern as a given symbol, matched on any combination of kind, return type, parameter count, and decorator. Useful for finding systemic bugs or understanding conventions.',
      inputSchema: z.object({
        symbol_name: z.string().describe('Name of the symbol to find similar patterns for'),
        file_path: z
          .string()
          .optional()
          .describe('Optional file path to disambiguate when multiple symbols share the name'),
        match_on: z
          .array(z.enum(['kind', 'return_type', 'param_count', 'decorator']))
          .default(['kind', 'return_type', 'param_count', 'decorator'])
          .describe('Which attributes to match on (default: all)'),
      }),
    },
    async ({ symbol_name, file_path, match_on }) => {
      const store = IndexerDB.getInstance()
      try {
        const name = symbol_name as string
        const matchDims = (match_on as string[]) ?? ['kind', 'return_type', 'param_count', 'decorator']
        const db = store.getDb()

        const candidates = await store.searchSymbols(
          name,
          undefined,
          file_path as string | undefined,
          5,
        )

        if (candidates.length === 0) {
          return {
            content: [{ type: 'text', text: `Symbol '${name}' not found in index.` }],
          }
        }

        const target = candidates[0]!
        const ambiguityNote =
          candidates.length > 1 && !file_path
            ? `Note: using first match (${target.file_path}:${target.line + 1}). Provide file_path to disambiguate.\n\n`
            : ''

        // Parse target param count
        let targetParamCount: number | null = null
        if (target.parameters_json) {
          try {
            targetParamCount = (JSON.parse(target.parameters_json) as unknown[]).length
          } catch {
            // ignore
          }
        }

        // Build DB-level conditions (kind, return_type, decorator)
        const conditions: SQL[] = [not(eq(schema.symbols.id, target.id))]

        if (matchDims.includes('kind')) {
          conditions.push(eq(schema.symbols.kind, target.kind))
        }

        if (matchDims.includes('return_type') && target.return_type) {
          conditions.push(like(schema.symbols.return_type, `%${target.return_type}%`))
        }

        if (matchDims.includes('decorator') && target.decorator) {
          conditions.push(eq(schema.symbols.decorator, target.decorator))
        }

        let results = await db
          .select()
          .from(schema.symbols)
          .where(and(...conditions))
          .limit(100)

        // Apply param_count filter in-memory (avoids need for raw sql json_array_length)
        if (matchDims.includes('param_count') && targetParamCount !== null) {
          results = results.filter((s) => {
            if (!s.parameters_json) return targetParamCount === 0
            try {
              return (JSON.parse(s.parameters_json) as unknown[]).length === targetParamCount
            } catch {
              return false
            }
          })
        }

        results = results.slice(0, 20)

        if (results.length === 0) {
          const matchDesc = matchDims.join(', ')
          return {
            content: [
              {
                type: 'text',
                text: `No similar patterns found for '${name}' matching on: ${matchDesc}`,
              },
            ],
          }
        }

        const targetDesc = [
          `kind: ${target.kind}`,
          target.return_type ? `returns: ${target.return_type}` : null,
          targetParamCount !== null ? `${targetParamCount} param${targetParamCount !== 1 ? 's' : ''}` : null,
          target.decorator ? `@${target.decorator}` : null,
        ]
          .filter(Boolean)
          .join(', ')

        const resultLines = results.map((s) => {
          let paramDesc = ''
          if (s.parameters_json) {
            try {
              const params = JSON.parse(s.parameters_json) as Array<{ name: string; type?: string }>
              paramDesc = params.length > 0
                ? `(${params.map((p) => `${p.name}: ${p.type ?? '?'}`).join(', ')})`
                : '()'
            } catch {
              paramDesc = ''
            }
          }
          let line = `  [${s.kind.toUpperCase()}] ${s.name} (${s.file_path}:${s.line + 1})`
          if (s.decorator) line += ` @${s.decorator}`
          if (s.return_type) line += `\n    Returns: ${s.return_type}`
          if (paramDesc) line += `\n    Params: ${paramDesc}`
          if (s.docstring) line += `\n    Doc: ${s.docstring.split('\n')[0]}`
          return line
        })

        return {
          content: [
            {
              type: 'text',
              text: `${ambiguityNote}Symbols similar to: ${name} (${targetDesc})\n\nFound ${results.length} similar pattern${results.length !== 1 ? 's' : ''}:\n\n${resultLines.join('\n\n')}`,
            },
          ],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error finding similar patterns: ${err}` }],
          isError: true,
        }
      }
    },
  )
}
