import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { updateUsage } from 'src/utils/updateUsage'

/** Registers a tool to detect circular import dependencies using Tarjan's SCC algorithm. */
export function registerGetDependencyCyclesTool(server: McpServer) {
  server.registerTool(
    'get_dependency_cycles',
    {
      title: 'Get Dependency Cycles',
      description:
        "Detect circular import dependencies in the project using Tarjan's SCC algorithm. " +
        'Circular imports cause subtle initialization bugs, prevent clean tree-shaking, and make modules hard to test in isolation. ' +
        '\n\n' +
        'SCOPE: Only intra-project imports (both files present in the index) are analysed. ' +
        'Package/node_modules/external dependencies are excluded. ' +
        '\n\n' +
        'OUTPUT FORMAT: Cycles sorted by length (longest first — generally most problematic). ' +
        'Each cycle is shown as a chain of `→ file` lines plus a `↩ (back to X)` line. ' +
        'If the result is "No circular dependencies found", the import graph is a DAG. ' +
        '\n\n' +
        'HOW TO FIX CYCLES: ' +
        '(1) Extract shared code into a third module that neither circular participant imports. ' +
        '(2) Use dependency injection to break the compile-time dependency. ' +
        '(3) Convert one direction to a runtime import (lazy/dynamic). ' +
        '\n\n' +
        'FOLLOW-UP TOOLS: Use `get_coupling_metrics` (sort by instability) to measure how much each file in a cycle ' +
        'is affected by the tight coupling. Use `find_symbol_references` to find which specific symbols are causing the cycle.',
      inputSchema: z.object({
        max_cycles: z
          .number()
          .default(20)
          .describe(
            'Maximum number of cycles to return, sorted by cycle length descending (default 20).',
          ),
      }),
    },
    async ({ max_cycles }) => {
      const store = IndexerDB.getInstance()
      try {
        const maxCycles = (max_cycles as number) ?? 20

        // Build the file-level import graph restricted to indexed files
        const allFiles = await store.files.getAll()
        const filePathSet = new Set(allFiles.map((f) => f.path))

        const allImports = await store.imports.getAll()

        // adjacency: from → Set<to> (both must be indexed files)
        const adj = new Map<string, Set<string>>()
        for (const imp of allImports) {
          if (
            !filePathSet.has(imp.file_path) ||
            !filePathSet.has(imp.module_path)
          ) {
            continue
          }
          if (imp.file_path === imp.module_path) continue // self-import, skip
          const set = adj.get(imp.file_path) ?? new Set<string>()
          set.add(imp.module_path)
          adj.set(imp.file_path, set)
        }

        if (adj.size === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No intra-project import edges found. Either the project has no relative imports or the index is empty.',
              },
            ],
          }
        }

        // Tarjan's SCC (iterative to avoid call-stack limits on large graphs)
        const index = new Map<string, number>()
        const lowlink = new Map<string, number>()
        const onStack = new Set<string>()
        const stack: string[] = []
        const cycles: string[][] = []
        let counter = 0

        // Iterative Tarjan using explicit call stack
        const nodes = [...adj.keys()]
        for (const startNode of nodes) {
          if (index.has(startNode)) continue

          // Stack frame: [node, iterator over neighbours, parentLowlink]
          type Frame = { node: string; neighbours: string[]; ni: number }
          const callStack: Frame[] = []

          /** Visits a node during depth-first search (DFS) to mark it with an index and lowlink value, which are used to identify strongly connected components in a graph. */
          const visit = (v: string) => {
            index.set(v, counter)
            lowlink.set(v, counter)
            counter++
            stack.push(v)
            onStack.add(v)
            callStack.push({
              node: v,
              neighbours: [...(adj.get(v) ?? [])],
              ni: 0,
            })
          }

          visit(startNode)

          while (callStack.length > 0) {
            const frame = callStack[callStack.length - 1]!
            if (frame.ni < frame.neighbours.length) {
              const w = frame.neighbours[frame.ni++]!
              if (!index.has(w)) {
                visit(w)
              } else if (onStack.has(w)) {
                lowlink.set(
                  frame.node,
                  Math.min(lowlink.get(frame.node)!, index.get(w)!),
                )
              }
            } else {
              // Pop frame
              callStack.pop()
              if (callStack.length > 0) {
                const parent = callStack[callStack.length - 1]!
                lowlink.set(
                  parent.node,
                  Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!),
                )
              }

              // Check if frame.node is SCC root
              if (lowlink.get(frame.node) === index.get(frame.node)) {
                const scc: string[] = []
                let w: string
                do {
                  w = stack.pop()!
                  onStack.delete(w)
                  scc.push(w)
                } while (w !== frame.node)
                if (scc.length > 1) {
                  cycles.push(scc)
                }
              }
            }
          }
        }

        if (cycles.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No circular dependencies found across ${allFiles.length} indexed files. The import graph is a DAG.`,
              },
            ],
          }
        }

        // Sort by cycle length descending, take top N
        cycles.sort((a, b) => b.length - a.length)
        const topCycles = cycles.slice(0, maxCycles)

        const lines: string[] = [
          `Found ${cycles.length} circular dependency cycle${cycles.length !== 1 ? 's' : ''} (showing top ${topCycles.length}):\n`,
        ]

        topCycles.forEach((cycle, i) => {
          lines.push(`Cycle ${i + 1} (${cycle.length} files):`)
          // Reorder for readability: show as a loop
          for (const file of cycle) {
            lines.push(`  → ${file}`)
          }
          lines.push(`  ↩ (back to ${cycle[cycle.length - 1]})`)
          lines.push('')
        })

        lines.push(
          'Tip: use get_coupling_metrics to measure the instability impact. Consider dependency injection or barrel re-exports to break cycles.',
        )

        const output = lines.join('\n')

        // Analytics computation
        updateUsage('get_dependency_cycles', [], output.length)

        return {
          content: [{ type: 'text', text: output }],
        }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Error detecting dependency cycles: ${err}` },
          ],
          isError: true,
        }
      }
    },
  )
}
