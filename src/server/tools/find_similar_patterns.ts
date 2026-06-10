import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { eq, and, like, not, SQL } from 'drizzle-orm'
import * as schema from '../../database/schemas'
import { updateUsage } from 'src/utils/updateUsage'

/** Registers a tool to find symbols with structurally similar patterns (kind, return type, parameter count, decorator). */
export function registerFindSimilarPatternsTool(server: McpServer) {
  server.registerTool(
    'find_similar_patterns',
    {
      title: 'Find Similar Patterns',
      description:
        'Find symbols with the same structural shape as a given reference symbol, matching on any combination of ' +
        'kind (function/class/method/etc.), return type, parameter count, and decorator. ' +
        '\n\n' +
        'USE THIS TOOL (not search_symbols) when you care about structure, not name. Examples: ' +
        '"find all functions that return Promise<void> and take 2 parameters", ' +
        '"find all @Controller-decorated classes like this one", ' +
        '"find every function with the same signature shape so I can apply this fix consistently". ' +
        '\n\n' +
        'WHEN TO USE: Applying a bug fix or refactor pattern across all structurally similar symbols; ' +
        'auditing whether a convention is followed consistently; discovering related implementations ' +
        'when you only have one example. ' +
        '\n\n' +
        'OUTPUT FORMAT: Each matching symbol shows kind, name, file:line, decorator, return type, ' +
        'parameter list, and first line of docstring. ' +
        '\n\n' +
        'TIPS: Start with `match_on: ["kind", "decorator"]` if you want broad structural matches, ' +
        'then narrow with `return_type` or `param_count`. ' +
        'Provide `file_path` if the reference symbol name is ambiguous.',
      inputSchema: z.object({
        symbol_name: z
          .string()
          .describe('Name of the symbol to find similar patterns for'),
        file_path: z
          .string()
          .optional()
          .describe(
            'Optional file path to disambiguate when multiple symbols share the name',
          ),
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
        const matchDims = (match_on as string[]) ?? [
          'kind',
          'return_type',
          'param_count',
          'decorator',
        ]
        const db = store.getDb()

        const candidates = await store.searchSymbols(
          name,
          undefined,
          file_path as string | undefined,
          5,
        )

        if (candidates.length === 0) {
          return {
            content: [
              { type: 'text', text: `Symbol '${name}' not found in index.` },
            ],
          }
        }

        if (candidates.length > 1 && !file_path) {
          return {
            content: [
              {
                type: 'text',
                text: `Multiple symbols named '${name}' found. Please specify a file_path to disambiguate.`,
              },
            ],
          }
        }

        const target = candidates[0]!

        // Parse target param count
        let targetParamCount: number | null = null
        if (target.parameters_json) {
          try {
            targetParamCount = (JSON.parse(target.parameters_json) as unknown[])
              .length
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
          conditions.push(
            like(schema.symbols.return_type, `%${target.return_type}%`),
          )
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
              return (
                (JSON.parse(s.parameters_json) as unknown[]).length ===
                targetParamCount
              )
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
          targetParamCount !== null
            ? `${targetParamCount} param${targetParamCount !== 1 ? 's' : ''}`
            : null,
          target.decorator ? `@${target.decorator}` : null,
        ]
          .filter(Boolean)
          .join(', ')

        const resultLines = results.map((s) => {
          let paramDesc = ''
          if (s.parameters_json) {
            try {
              const params = JSON.parse(s.parameters_json) as Array<{
                name: string
                type?: string
              }>
              paramDesc =
                params.length > 0
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

        const output = `Symbols similar to: ${name} (${targetDesc})\n\nFound ${results.length} similar pattern${results.length !== 1 ? 's' : ''}:\n\n${resultLines.join('\n\n')}`

        // Analytics computation
        const filePaths = new Set(results.map((s) => s.file_path))
        await updateUsage(
          'find_similar_patterns',
          Array.from(filePaths),
          output.length,
        )

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Error finding similar patterns: ${err}` },
          ],
          isError: true,
        }
      }
    },
  )
}
