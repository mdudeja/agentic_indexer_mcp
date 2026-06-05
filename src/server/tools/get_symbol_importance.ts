import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { isNotNull, inArray } from 'drizzle-orm'
import * as schema from '../../database/schemas'
import { AppStateManager } from 'src/state'

const ALL_KINDS = Object.keys(
  schema.SymbolKind,
) as (keyof typeof schema.SymbolKind)[]

const DAMPING = 0.85
const ITERATIONS = 30

/** Registers a tool to rank symbols by structural importance using PageRank on the call graph. */
export function registerGetSymbolImportanceTool(server: McpServer) {
  server.registerTool(
    'get_symbol_importance',
    {
      title: 'Get Symbol Importance',
      description:
        'Rank codebase symbols by structural centrality using PageRank on the call graph. Symbols called by many other important symbols score higher. Useful for identifying critical utilities, core services, and high-leverage refactoring targets. Only symbols with resolved call edges (callee_id IS NOT NULL) participate in the ranking.',
      inputSchema: z.object({
        limit: z
          .number()
          .default(20)
          .describe('Number of top symbols to return (default 20).'),
        kind: z
          .array(z.enum(ALL_KINDS))
          .optional()
          .describe('Filter results to specific symbol kinds.'),
        exclude_tests: z
          .boolean()
          .default(true)
          .describe('Exclude test file symbols from results (default true).'),
      }),
    },
    async ({ limit, kind, exclude_tests }) => {
      const store = IndexerDB.getInstance()
      try {
        const db = store.getDb()
        const maxLimit = (limit as number) ?? 20

        // Load all resolved call edges
        const edges = await db
          .select({
            caller: schema.symbol_calls.caller_id,
            callee: schema.symbol_calls.callee_id,
          })
          .from(schema.symbol_calls)
          .where(isNotNull(schema.symbol_calls.callee_id))

        if (edges.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No resolved call edges found. Re-index the project to populate the call graph.',
              },
            ],
          }
        }

        // Collect all unique node IDs
        const nodeIds = new Set<string>()
        for (const e of edges) {
          nodeIds.add(e.caller)
          if (e.callee) nodeIds.add(e.callee)
        }
        const N = nodeIds.size

        // Build out-edges map (caller → list of callees)
        const outEdges = new Map<string, string[]>()
        for (const e of edges) {
          if (!e.callee) continue
          const list = outEdges.get(e.caller) ?? []
          list.push(e.callee)
          outEdges.set(e.caller, list)
        }

        // Initialize rank uniformly
        let rank = new Map<string, number>()
        for (const id of nodeIds) rank.set(id, 1 / N)

        // Iterative PageRank
        for (let i = 0; i < ITERATIONS; i++) {
          const newRank = new Map<string, number>()
          for (const id of nodeIds) newRank.set(id, (1 - DAMPING) / N)

          for (const [caller, callees] of outEdges) {
            const contribution =
              (DAMPING * (rank.get(caller) ?? 0)) / callees.length
            for (const callee of callees) {
              newRank.set(callee, (newRank.get(callee) ?? 0) + contribution)
            }
          }
          rank = newRank
        }

        // Sort by rank descending
        let sorted = [...rank.entries()].sort((a, b) => b[1] - a[1])

        // Fetch symbol details for all top candidates (fetch more than limit to allow filtering)
        const fetchIds = sorted.slice(0, maxLimit * 5).map(([id]) => id)
        const symbols = await db
          .select()
          .from(schema.symbols)
          .where(inArray(schema.symbols.id, fetchIds))

        const symbolMap = new Map(symbols.map((s) => [s.id, s]))

        // Apply filters and take top N
        const TEST_RE =
          AppStateManager.getInstance()
            .getItem('config')
            ?.testFilePatterns.map((p) => {
              if (p instanceof RegExp) return p
              if (typeof p === 'string') return new RegExp(p)
              return null
            })
            .filter((p): p is RegExp => p !== null) ?? null
        const results: Array<{ symbol: (typeof symbols)[0]; score: number }> =
          []
        for (const [id, score] of sorted) {
          if (results.length >= maxLimit) break
          const sym = symbolMap.get(id)
          if (!sym) continue
          if (exclude_tests && TEST_RE?.some((re) => re.test(sym.file_path))) {
            continue
          }
          if (
            kind &&
            (kind as string[]).length > 0 &&
            !(kind as string[]).includes(sym.kind)
          ) {
            continue
          }
          results.push({ symbol: sym, score })
        }

        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No symbols matched the filters after PageRank computation.',
              },
            ],
          }
        }

        const lines: string[] = [
          `Top ${results.length} symbols by call-graph importance (PageRank, d=${DAMPING}):\n`,
          `${'Rank'.padEnd(6)} ${'Score'.padEnd(10)} ${'Kind'.padEnd(14)} ${'Symbol'}\n${'─'.repeat(70)}`,
        ]

        results.forEach(({ symbol: s, score }, i) => {
          lines.push(
            `${String(i + 1).padEnd(6)} ${score.toFixed(6).padEnd(10)} ${s.kind.padEnd(14)} ${s.name}  ${s.file_path}:${s.line + 1}`,
          )
        })

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
        }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Error computing symbol importance: ${err}` },
          ],
          isError: true,
        }
      }
    },
  )
}
