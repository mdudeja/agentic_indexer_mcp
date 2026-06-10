import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { isNotNull, inArray, isNull } from 'drizzle-orm'
import * as schema from '../../database/schemas'
import { AppStateManager } from 'src/state'
import { allCallableKinds } from 'src/utils/allCallableKinds'
import { allContainerKinds } from 'src/utils/allContainerKinds'
import { updateUsage } from 'src/utils/updateUsage'

function toNodeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_')
}

function truncate(s: string, max = 80): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** Registers a tool to produce a Mermaid knowledge graph showing callable symbols and import/export chains,
 *  grouped by container (class/namespace/module) within file subgraphs, with entry-point traces highlighted. */
export async function registerExploreCodebaseTool(server: McpServer) {
  const CALLABLE_KINDS = await allCallableKinds()
  const CONTAINER_KINDS = await allContainerKinds()
  const DEFAULT_KINDS = Array.from(
    new Set([...CALLABLE_KINDS, ...CONTAINER_KINDS]),
  ).sort() as (keyof typeof schema.SymbolKind)[]

  server.registerTool(
    'explore_codebase',
    {
      title: 'Explore Codebase',
      description:
        'Generate a Mermaid call-graph of the indexed codebase. Use this as your first step when you need to ' +
        'understand how a codebase is wired together — what calls what, where execution starts, which symbols are ' +
        'exported vs internal, and how subsystems relate to each other. ' +
        '\n\n' +
        'OUTPUT FORMAT: Returns a summary line followed by a ```mermaid``` code block. ' +
        'Nodes are grouped in nested subgraphs: file → class/namespace → symbol. ' +
        '\n\n' +
        'READING THE GRAPH: ' +
        '‼️ subgraph label = entry-point file (matches entryPointPatterns in config). ' +
        'Thick ==> arrows = call edges on the BFS-reachable path from entry points (the hot path). ' +
        'Thin --> arrows = other resolved call edges. ' +
        'Dashed -.-> arrows = calls to unresolved/external symbols (only shown when include_unresolved=true). ' +
        'Yellow nodes = symbols that live in entry-point files. ' +
        'Blue nodes = symbols BFS-reachable from entry points. ' +
        'Parallelogram shape = entry-file symbol; square = exported symbol; rounded = internal symbol. ' +
        '\n\n' +
        'WHEN THE GRAPH IS TRUNCATED: If the summary says "truncated from N", the codebase is large. ' +
        'Use file_pattern to zoom into one subsystem (e.g. "src/server") or kind to restrict symbol types. ' +
        'Re-call with those filters rather than trying to reason from an incomplete graph.',
      inputSchema: z.object({
        file_pattern: z
          .string()
          .optional()
          .describe(
            'Optional substring filter applied to file paths (e.g. "src/server"). ' +
              'Only symbols from matching files are included.',
          ),
        kind: z
          .array(z.enum(DEFAULT_KINDS))
          .optional()
          .describe(
            'Restrict graph to these symbol kinds. ' +
              'Omit to use callable_kinds from config plus import and export.',
          ),
        include_unresolved: z
          .boolean()
          .default(false)
          .describe(
            'When true, also add ghost nodes for callees that could not be resolved. Default false.',
          ),
        max_nodes: z
          .number()
          .default(80)
          .describe(
            'Hard cap on symbol nodes rendered (default 80). ' +
              'Entry-point and highly-connected nodes are prioritised.',
          ),
      }),
    },
    async ({ file_pattern, kind, include_unresolved, max_nodes }) => {
      const store = IndexerDB.getInstance()
      try {
        const db = store.getDb()
        const maxNodes = (max_nodes as number) ?? 80
        const includeUnresolved = (include_unresolved as boolean) ?? false

        const entryPatterns =
          AppStateManager.getInstance()
            .getItem('config')
            ?.entryPointPatterns.map((p) =>
              p instanceof RegExp ? p : new RegExp(p),
            ) ?? []

        const activeKinds: (keyof typeof schema.SymbolKind)[] = kind?.length
          ? kind
          : DEFAULT_KINDS

        // --- 1. Fetch candidate symbols and all files ---
        const [allSymbols, allFiles] = await Promise.all([
          store.getAllSymbols(),
          store.getAllFiles(),
        ])

        const entryPointFiles = new Set(
          allFiles
            .filter((f) => entryPatterns.some((re) => re.test(f.path)))
            .map((f) => f.path),
        )

        const candidateSymbols = allSymbols.filter((s) => {
          if (!activeKinds.includes(s.kind as keyof typeof schema.SymbolKind)) {
            return false
          }
          if (file_pattern && !s.file_path.includes(file_pattern)) return false
          return true
        })

        if (candidateSymbols.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No symbols matched the given filters. Try broadening `file_pattern` or `kind`.',
              },
            ],
          }
        }

        // --- 2. Fetch all resolved call edges ---
        const allEdges = await db
          .select({
            caller_id: schema.symbol_calls.caller_id,
            callee_id: schema.symbol_calls.callee_id,
            callee_name: schema.symbol_calls.callee_name,
            caller_file_path: schema.symbol_calls.caller_file_path,
          })
          .from(schema.symbol_calls)
          .where(isNotNull(schema.symbol_calls.callee_id))

        // --- 3. BFS from entry point symbols to find reachable set ---
        const entrySymbolIds = new Set(
          allSymbols
            .filter((s) => entryPointFiles.has(s.file_path))
            .map((s) => s.id),
        )

        const callMap = new Map<string, Set<string>>()
        for (const e of allEdges) {
          if (!e.callee_id) continue
          const callees = callMap.get(e.caller_id) ?? new Set()
          callees.add(e.callee_id)
          callMap.set(e.caller_id, callees)
        }

        const reachableFromEntry = new Set<string>()
        const bfsQueue = [...entrySymbolIds]
        while (bfsQueue.length > 0) {
          const id = bfsQueue.pop()!
          if (reachableFromEntry.has(id)) continue
          reachableFromEntry.add(id)
          const callees = callMap.get(id)
          if (callees) {
            for (const callee of callees) {
              if (!reachableFromEntry.has(callee)) bfsQueue.push(callee)
            }
          }
        }

        // --- 4. Score nodes by connectivity and entry-point proximity ---
        const candidateIds = new Set(candidateSymbols.map((s) => s.id))

        type EdgeRecord = {
          callerId: string
          calleeId: string
          callerFile: string
        }
        const relevantEdges: EdgeRecord[] = []
        const degreeMap = new Map<string, number>()

        for (const e of allEdges) {
          if (!e.callee_id) continue
          const callerIn = candidateIds.has(e.caller_id)
          const calleeIn = candidateIds.has(e.callee_id)
          if (!callerIn && !calleeIn) continue

          relevantEdges.push({
            callerId: e.caller_id,
            calleeId: e.callee_id,
            callerFile: e.caller_file_path,
          })
          degreeMap.set(e.caller_id, (degreeMap.get(e.caller_id) ?? 0) + 1)
          degreeMap.set(e.callee_id, (degreeMap.get(e.callee_id) ?? 0) + 1)
        }

        const nodeScore = (sym: schema.IndexedSymbol['Select']) =>
          (degreeMap.get(sym.id) ?? 0) +
          (entryPointFiles.has(sym.file_path) ? 1000 : 0) +
          (reachableFromEntry.has(sym.id) ? 100 : 0)

        const sortedCandidates = [...candidateSymbols].sort(
          (a, b) => nodeScore(b) - nodeScore(a),
        )

        const keptNodes = new Set(
          sortedCandidates.slice(0, maxNodes).map((s) => s.id),
        )

        const filteredEdges = relevantEdges.filter(
          (e) => keptNodes.has(e.callerId) && keptNodes.has(e.calleeId),
        )

        // --- 5. Optionally add unresolved ghost nodes ---
        const ghostNodes = new Map<string, string>()
        const ghostEdges: { callerId: string; ghostId: string }[] = []

        if (includeUnresolved) {
          const unresolvedEdges = await db
            .select({
              caller_id: schema.symbol_calls.caller_id,
              callee_name: schema.symbol_calls.callee_name,
            })
            .from(schema.symbol_calls)
            .where(isNull(schema.symbol_calls.callee_id))

          for (const e of unresolvedEdges) {
            if (!keptNodes.has(e.caller_id)) continue
            const ghostId =
              ghostNodes.get(e.callee_name) ??
              `ghost_${toNodeId(e.callee_name)}`
            ghostNodes.set(e.callee_name, ghostId)
            ghostEdges.push({ callerId: e.caller_id, ghostId })
          }
        }

        // --- 6. Fetch container parents for grouping ---
        const keptSymbols = sortedCandidates.slice(0, maxNodes)
        const parentIds = [
          ...new Set(
            keptSymbols
              .map((s) => s.parent_id)
              .filter((id): id is string => id != null),
          ),
        ]

        const parentSymbols =
          parentIds.length > 0
            ? await db
                .select()
                .from(schema.symbols)
                .where(inArray(schema.symbols.id, parentIds))
            : []

        const containerById = new Map(
          parentSymbols
            .filter((p) => CONTAINER_KINDS.includes(p.kind))
            .map((p) => [p.id, p]),
        )

        // --- 7. Group by file → container → symbols ---
        type ContainerGroup = {
          sym: (typeof parentSymbols)[0]
          children: typeof keptSymbols
        }
        type FileGroup = {
          containers: Map<string, ContainerGroup>
          orphans: typeof keptSymbols
        }

        const byFile = new Map<string, FileGroup>()
        for (const sym of keptSymbols) {
          const fg: FileGroup = byFile.get(sym.file_path) ?? {
            containers: new Map(),
            orphans: [],
          }

          if (sym.parent_id && containerById.has(sym.parent_id)) {
            const existing = fg.containers.get(sym.parent_id)
            if (existing) {
              existing.children.push(sym)
            } else {
              fg.containers.set(sym.parent_id, {
                sym: containerById.get(sym.parent_id)!,
                children: [sym],
              })
            }
          } else {
            fg.orphans.push(sym)
          }

          byFile.set(sym.file_path, fg)
        }

        // --- 8. Render Mermaid ---
        const lines: string[] = ['graph LR']
        let sgIdx = 0

        const renderNode = (
          sym: (typeof keptSymbols)[0],
          indent: string,
        ): void => {
          const nodeId = toNodeId(sym.id)
          const label = truncate(`${sym.kind} ${sym.name}`)
          const isEntry = entryPointFiles.has(sym.file_path)

          // Shape: parallelogram for entry-file symbols, square for exported, rounded for internal
          if (isEntry) {
            lines.push(`${indent}${nodeId}[/"${label}"/]`)
          } else if (sym.exported) {
            lines.push(`${indent}${nodeId}["${label}"]`)
          } else {
            lines.push(`${indent}${nodeId}(["${label}"])`)
          }
        }

        // Entry-point files first, then others
        const orderedFiles = [
          ...[...byFile.keys()].filter((f) => entryPointFiles.has(f)),
          ...[...byFile.keys()].filter((f) => !entryPointFiles.has(f)),
        ]

        for (const filePath of orderedFiles) {
          const fg = byFile.get(filePath)!
          const sgId = `sg${sgIdx++}`
          const parts = filePath.split('/')
          const label = parts.slice(-2).join('/')
          const isEntryFile = entryPointFiles.has(filePath)

          lines.push(
            `  subgraph ${sgId}["${isEntryFile ? '‼️ ' : ''}${label}"]`,
          )

          for (const sym of fg.orphans) {
            renderNode(sym, '    ')
          }

          for (const [, ctr] of fg.containers) {
            const ctrSgId = `sg${sgIdx++}`
            const ctrLabel = truncate(`${ctr.sym.kind} ${ctr.sym.name}`)
            lines.push(`    subgraph ${ctrSgId}["${ctrLabel}"]`)
            for (const child of ctr.children) {
              renderNode(child, '      ')
            }
            lines.push('    end')
          }

          lines.push('  end')
        }

        // Ghost nodes (unresolved callees)
        if (ghostNodes.size > 0) {
          lines.push('  subgraph ghost["External / Unresolved"]')
          for (const [name, ghostId] of ghostNodes) {
            lines.push(`    ${ghostId}["${truncate(name)}"]:::ghost`)
          }
          lines.push('  end')
        }

        // Edges: thick (==>) for entry-trace path, dashed (-->) otherwise
        const seenEdges = new Set<string>()
        for (const e of filteredEdges) {
          const key = `${e.callerId}→${e.calleeId}`
          if (seenEdges.has(key)) continue
          seenEdges.add(key)
          const onTrace =
            reachableFromEntry.has(e.callerId) &&
            reachableFromEntry.has(e.calleeId)
          lines.push(
            `  ${toNodeId(e.callerId)} ${onTrace ? '==>' : '-->'} ${toNodeId(e.calleeId)}`,
          )
        }
        for (const e of ghostEdges) {
          const key = `${e.callerId}→${e.ghostId}`
          if (seenEdges.has(key)) continue
          seenEdges.add(key)
          lines.push(`  ${toNodeId(e.callerId)} -.-> ${e.ghostId}`)
        }

        // Style classes
        lines.push(
          '  classDef ghost fill:#f5f5f5,stroke:#aaa,color:#999,stroke-dasharray:4',
        )
        lines.push(
          '  classDef entry fill:#fef3c7,stroke:#f59e0b,color:#92400e,font-weight:bold',
        )
        lines.push(
          '  classDef reachable fill:#dbeafe,stroke:#3b82f6,color:#1e3a8a',
        )

        // Apply classes to nodes
        const entryNodes: string[] = []
        const reachableNodes: string[] = []
        for (const sym of keptSymbols) {
          const nodeId = toNodeId(sym.id)
          if (entryPointFiles.has(sym.file_path)) {
            entryNodes.push(nodeId)
          } else if (reachableFromEntry.has(sym.id)) {
            reachableNodes.push(nodeId)
          }
        }
        if (entryNodes.length > 0)
          lines.push(`  class ${entryNodes.join(',')} entry`)
        if (reachableNodes.length > 0)
          lines.push(`  class ${reachableNodes.join(',')} reachable`)

        const mermaid = lines.join('\n')

        const nodeCount = keptNodes.size
        const edgeCount = seenEdges.size
        const totalCandidates = candidateSymbols.length
        const truncated = totalCandidates > maxNodes

        const entryFileList = [...entryPointFiles]
          .filter((f) => byFile.has(f))
          .map((f) => f.split('/').slice(-2).join('/'))
          .join(', ')

        const summary =
          `Knowledge graph: ${nodeCount} nodes, ${edgeCount} edges` +
          (truncated
            ? ` (truncated from ${totalCandidates} — increase max_nodes or narrow file_pattern/kind to see more)`
            : '') +
          (entryFileList
            ? `\nEntry points (⚡): ${entryFileList}`
            : '\nNo entry-point files matched entryPointPatterns.') +
          `\nReachable from entry: ${reachableNodes.length} node(s) highlighted in blue; entry-trace edges shown with thick arrows.\n\n` +
          '```mermaid\n' +
          mermaid +
          '\n```'

        // Analytics computation
        updateUsage('explore_codebase', [], summary.length)

        return { content: [{ type: 'text', text: summary }] }
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: `explore_codebase failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        }
      }
    },
  )
}
