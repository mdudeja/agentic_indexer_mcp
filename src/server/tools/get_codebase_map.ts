import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { eq, and, isNull, sql, inArray, notInArray, or, not } from 'drizzle-orm'
import * as schema from '../../database/schemas'
import { updateUsage } from 'src/utils/updateUsage'

/** Registers a tool to produce a top-down architectural map of the codebase grouped by directory. */
export function registerGetCodebaseMapTool(server: McpServer) {
  server.registerTool(
    'get_codebase_map',
    {
      title: 'Get Codebase Map',
      description:
        'Produce a text-based architectural overview of the codebase: files grouped by directory, ' +
        'a layered dependency topology (entry points → foundation), key exported symbols per module, and cross-module dependency edges. ' +
        '\n\n' +
        'USE THIS TOOL WHEN you need a fast, scannable answer to "what modules exist, how are they layered, and what are their main exports?" — ' +
        'it is the right starting point for orienting in an unfamiliar codebase before diving deeper. ' +
        '\n\n' +
        'USE explore_codebase INSTEAD WHEN you need to see actual call edges between individual symbols ' +
        '(functions/classes calling each other), trace the hot execution path from an entry point, or understand ' +
        'how a specific subsystem is wired internally. explore_codebase renders a Mermaid graph; this tool returns plain text. ' +
        '\n\n' +
        'OUTPUT FORMAT: Three sections — (1) Architecture: one row per dependency layer, ordered entry-points → foundation. ' +
        '(2) Dependency graph: each module → the modules it calls into. ' +
        '(3) Module details: per-directory block listing the top exported symbols ranked by how often they are called, ' +
        "with the most-called symbol's docstring shown if available. " +
        '\n\n' +
        'TIPS: Increase depth (2 or 3) if the top-level grouping is too coarse. ' +
        'Increase max_key_symbols to see more exports per module. ' +
        'Foundation modules (layer 0) have no outgoing cross-module dependencies — they are the building blocks everything else imports.',
      inputSchema: z.object({
        depth: z
          .number()
          .default(1)
          .describe(
            'Directory depth to group files by (1 = top-level dirs, 2 = two levels deep). Default 1.',
          ),
        max_key_symbols: z
          .number()
          .default(5)
          .describe('Max number of key symbols to show per group. Default 5.'),
      }),
    },
    async ({ depth, max_key_symbols }) => {
      const store = IndexerDB.getInstance()
      try {
        const db = store.getDb()
        const maxDepth = (depth as number) ?? 1
        const maxKeySymbols = (max_key_symbols as number) ?? 5

        const allFiles = await store.getAllFiles()
        if (allFiles.length === 0) {
          return { content: [{ type: 'text', text: 'No files indexed yet.' }] }
        }

        // Group files by directory depth (filename excluded from depth count).
        const groups = new Map<string, string[]>()
        for (const file of allFiles) {
          const parts = file.path.split('/')
          const dirParts = parts.slice(0, -1)
          const prefix =
            dirParts.length === 0
              ? '(root)'
              : dirParts.slice(0, maxDepth).join('/')
          const list = groups.get(prefix) ?? []
          list.push(file.path)
          groups.set(prefix, list)
        }

        // collect data for every group: key exported symbols + outgoing dependencies (callees in other groups)
        type SymRow = {
          name: string
          kind: string
          file_path: string
          line: number
          docstring: string | null
          call_count: number
        }
        type GroupInfo = {
          filePaths: string[]
          keySymbols: SymRow[]
          dependsOn: Set<string>
        }
        const groupInfo = new Map<string, GroupInfo>()

        for (const [prefix, filePaths] of groups) {
          const keySymbols = await db
            .select({
              name: schema.symbols.name,
              kind: schema.symbols.kind,
              file_path: schema.symbols.file_path,
              line: schema.symbols.line,
              docstring: schema.symbols.docstring,
              call_count: sql<number>`count(${schema.symbol_calls.id})`.as(
                'call_count',
              ),
            })
            .from(schema.symbols)
            .leftJoin(
              schema.symbol_calls,
              eq(schema.symbol_calls.callee_id, schema.symbols.id),
            )
            .where(
              and(
                or(
                  eq(schema.symbols.exported, true),
                  and(
                    not(isNull(schema.symbols.parent_id)),
                    sql<boolean>`exists (
                      select 1
                      from symbols as parent
                      where parent.id = ${schema.symbols.parent_id}
                        and parent.exported = true
                    )`,
                  ),
                ),
                inArray(schema.symbols.file_path, filePaths),
              ),
            )
            .groupBy(schema.symbols.id)
            .orderBy(sql`count(${schema.symbol_calls.id}) DESC`)
            .limit(maxKeySymbols)

          const dependsOn = new Set<string>()
          const calleeFiles = await db
            .selectDistinct({ file_path: schema.symbols.file_path })
            .from(schema.symbol_calls)
            .innerJoin(
              schema.symbols,
              eq(schema.symbols.id, schema.symbol_calls.callee_id),
            )
            .where(
              and(
                inArray(schema.symbol_calls.caller_file_path, filePaths),
                notInArray(schema.symbols.file_path, filePaths),
              ),
            )
          for (const { file_path } of calleeFiles) {
            const p = file_path.split('/')
            const d = p.slice(0, -1)
            const g = d.length === 0 ? '(root)' : d.slice(0, maxDepth).join('/')
            dependsOn.add(g)
          }

          groupInfo.set(prefix, { filePaths, keySymbols, dependsOn })
        }

        // compute layer (depth) of each group in the dependency graph, so we can present a layered architecture overview (entry points → foundation) and order the per-module details in a logical way.
        // Modules with no outgoing dependencies are at layer 0 (foundation); modules that depend only on foundation modules are at layer 1; and so on.
        const allGroupKeys = [...groups.keys()]
        const layerOf = new Map<string, number>()

        /** Recursively computes the layer (depth) of a group in the dependency graph. A group with no dependencies is at layer 0.
         * A group that depends on other groups is at one layer deeper than the maximum layer of its dependencies.
         * The function uses memoization to avoid redundant calculations and a visiting set to prevent infinite recursion in case of cycles. */
        const computeLayer = (
          g: string,
          visiting = new Set<string>(),
        ): number => {
          if (layerOf.has(g)) return layerOf.get(g)!
          if (visiting.has(g)) return 0 // cycle guard
          visiting.add(g)
          const knownDeps = [...(groupInfo.get(g)?.dependsOn ?? [])].filter(
            (d) => allGroupKeys.includes(d),
          )
          const layer =
            knownDeps.length === 0
              ? 0
              : 1 +
                Math.max(
                  ...knownDeps.map((d) => computeLayer(d, new Set(visiting))),
                )
          layerOf.set(g, layer)
          return layer
        }
        for (const g of allGroupKeys) computeLayer(g)

        const layerBuckets = new Map<number, string[]>()
        for (const g of allGroupKeys) {
          const l = layerOf.get(g) ?? 0
          const arr = layerBuckets.get(l) ?? []
          arr.push(g)
          layerBuckets.set(l, arr)
        }
        const maxLayer = Math.max(...layerBuckets.keys())

        // render
        const out: string[] = []
        out.push(
          `Codebase Map  ${allFiles.length} files · ${allGroupKeys.length} modules · depth=${maxDepth}`,
        )
        out.push('')

        // Topology overview: one row per layer, top-down (entry points first).
        out.push('Architecture (entry points → foundation):')
        for (let l = maxLayer; l >= 0; l--) {
          const members = (layerBuckets.get(l) ?? []).sort()
          const tag =
            l === maxLayer
              ? 'entry points'
              : l === 0
                ? 'foundation  '
                : `layer ${l}      `.slice(0, 12)
          out.push(`  ${tag}  ${members.join('  ·  ')}`)
        }
        out.push('')

        // Dependency graph: compact list showing outgoing deps for non-foundation modules.
        out.push('Dependency graph:')
        for (let l = maxLayer; l >= 1; l--) {
          for (const g of (layerBuckets.get(l) ?? []).sort()) {
            const deps = [...(groupInfo.get(g)?.dependsOn ?? [])]
              .sort()
              .join(', ')
            out.push(`  ${g.padEnd(28)} →  ${deps || '(none)'}`)
          }
        }
        out.push('')

        // Per-module details ordered foundation → entry points.
        out.push('Module details (foundation → entry points):')
        for (let l = 0; l <= maxLayer; l++) {
          for (const g of (layerBuckets.get(l) ?? []).sort()) {
            const info = groupInfo.get(g)!
            out.push('')
            out.push(
              `### ${g}  (${info.filePaths.length} file${info.filePaths.length !== 1 ? 's' : ''})`,
            )
            if (info.keySymbols.length === 0) {
              out.push('  (no exported symbols)')
            } else {
              // Top symbol gets its docstring; rest are listed inline.
              const [top, ...rest] = info.keySymbols as [SymRow, ...SymRow[]]
              const topLabel = `${top.name} [${top.kind}]${top.call_count ? ' ×' + top.call_count : ''}`
              const oneLiner = top.docstring
                ?.replace(/^\/\*\*\s*|\s*\*\/$/g, '')
                .split('\n')[0]
                ?.trim()
              out.push(
                oneLiner ? `  ${topLabel}: ${oneLiner}` : `  ${topLabel}`,
              )
              if (rest.length > 0) {
                const restStr = rest
                  .map(
                    (s) =>
                      `${s.name} [${s.kind}]${s.call_count ? ' ×' + s.call_count : ''}`,
                  )
                  .join(', ')
                out.push(`  + ${restStr}`)
              }
            }
          }
        }

        const output = out.join('\n')

        //usage computation
        await updateUsage('get_codebase_map', [], output.length)

        return { content: [{ type: 'text', text: output }] }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Error building codebase map: ${err}` },
          ],
          isError: true,
        }
      }
    },
  )
}
