import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolResult } from './index'
import { IndexerDB } from 'src/database/IndexerDB'
import { z } from 'zod'
import { updateUsage } from 'src/utils/updateUsage'
import { eq, and, isNull, inArray, isNotNull, SQL } from 'drizzle-orm'
import * as schema from 'src/database/schemas'
import { SymbolKind } from 'src/database/schemas'
import { allCallableKinds } from 'src/utils/allCallableKinds'
import { allContainerKinds } from 'src/utils/allContainerKinds'
import {
  doesPathMatch,
  getEntryPointGlobs,
  getTestFileGlobs,
} from 'src/utils/pathGlobs'
import type { SymRow } from 'src/database/types'
import { filePathToTopDir } from './helpers/format'

enum ARCH_MODE {
  codebase_map = 'codebase_map',
  entry_points = 'entry_points',
  explore = 'explore',
  coupling_metrics = 'coupling_metrics',
}

const ENTRY_KINDS = [
  SymbolKind.function,
  SymbolKind.class,
  SymbolKind.const,
  SymbolKind.arrowFunction,
  SymbolKind.interface,
  SymbolKind.type,
] as const

const SORT_OPTIONS = [
  'instability',
  'distance',
  'afferent',
  'efferent',
] as const

/** Registers the explore_architecture tool: top-down codebase structure. */
export function registerExploreArchitectureTool(server: McpServer) {
  server.registerTool(
    'explore_architecture',
    {
      title: 'Explore Architecture',
      description:
        'Top-down codebase structure and architecture. ' +
        '\n\n' +
        'FOUR MODES: ' +
        '`codebase_map` — text architectural overview: files grouped by directory, layered dependency topology (entry points → foundation), key exports per module. ' +
        '`entry_points` — list top-level exported symbols (the public API surface); with only_unreferenced=true, find true program entry points. ' +
        '`explore` — Mermaid call-graph with entry-point highlighting, file/container subgraphs, and reachability. ' +
        '`coupling_metrics` — Robert C. Martin Ce/Ca/I/A/D metrics to find tightly-coupled or poorly-abstracted files. ' +
        '\n\n' +
        'WHEN TO USE: To orient yourself in an unfamiliar codebase. ' +
        'Use `codebase_map` for a fast scannable overview, `entry_points` to find where execution starts, `explore` for a visual call-graph, and `coupling_metrics` for architectural review.',
      inputSchema: z.object({
        mode: z
          .enum(ARCH_MODE)
          .default(ARCH_MODE.codebase_map)
          .describe('What to explore (default: codebase_map)'),
        depth: z
          .number()
          .default(1)
          .optional()
          .describe('Directory depth to group by (codebase_map mode)'),
        max_key_symbols: z
          .number()
          .default(5)
          .optional()
          .describe('Max key symbols per group (codebase_map mode)'),
        kind: z
          .array(z.enum(ENTRY_KINDS))
          .optional()
          .describe('Filter by symbol kind (entry_points/explore modes)'),
        exclude_tests: z
          .boolean()
          .default(true)
          .optional()
          .describe('Exclude test files (entry_points mode)'),
        only_unreferenced: z
          .boolean()
          .default(false)
          .optional()
          .describe('Only show unreferenced exports (entry_points mode)'),
        file_pattern: z
          .string()
          .optional()
          .describe('Substring filter on file paths (all modes)'),
        include_unresolved: z
          .boolean()
          .default(false)
          .optional()
          .describe('Add ghost nodes for unresolved callees (explore mode)'),
        max_nodes: z
          .number()
          .default(80)
          .optional()
          .describe('Hard cap on symbol nodes (explore mode)'),
        sort_by: z
          .enum(SORT_OPTIONS)
          .default('distance')
          .optional()
          .describe('Sort coupling metrics by (coupling_metrics mode)'),
        limit: z
          .number()
          .default(30)
          .optional()
          .describe('Max files to return (coupling_metrics mode)'),
        min_symbols: z
          .number()
          .default(1)
          .optional()
          .describe('Min symbols a file must have (coupling_metrics mode)'),
      }),
    },
    async (args) => {
      const store = IndexerDB.getInstance()
      const mode = args.mode ?? ARCH_MODE.codebase_map

      switch (mode) {
        case ARCH_MODE.codebase_map:
          return codebaseMap(
            store,
            args.depth ?? 1,
            args.max_key_symbols ?? 5,
            args.file_pattern,
          )
        case ARCH_MODE.entry_points:
          return entryPoints(
            store,
            args.kind,
            args.file_pattern,
            args.exclude_tests,
            args.only_unreferenced,
          )
        case ARCH_MODE.explore:
          return explore(
            store,
            args.file_pattern,
            args.kind,
            args.include_unresolved,
            args.max_nodes,
          )
        case ARCH_MODE.coupling_metrics:
          return couplingMetrics(
            store,
            args.sort_by ?? 'distance',
            args.limit ?? 30,
            args.min_symbols ?? 1,
            args.file_pattern,
          )
        default:
          return {
            content: [{ type: 'text', text: `Unsupported mode: ${mode}` }],
            isError: true,
          }
      }
    },
  )
}

/** Produces a top-down architectural map grouped by directory. */
async function codebaseMap(
  store: IndexerDB,
  depth: number,
  max_key_symbols: number,
  file_pattern?: string,
): Promise<ToolResult> {
  try {
    const maxDepth = depth
    const maxKeySymbols = max_key_symbols

    let allFiles = await store.files.getAll()
    if (file_pattern) {
      allFiles = allFiles.filter((f) => f.path.includes(file_pattern))
    }

    if (allFiles.length === 0) {
      return { content: [{ type: 'text', text: 'No files indexed yet.' }] }
    }

    const groups = new Map<string, string[]>()
    for (const file of allFiles) {
      const prefix = filePathToTopDir(file.path)
      const list = groups.get(prefix) ?? []
      list.push(file.path)
      groups.set(prefix, list)
    }

    type GroupInfo = {
      filePaths: string[]
      keySymbols: SymRow[]
      dependsOn: Set<string>
    }
    const groupInfo = new Map<string, GroupInfo>()

    for (const [prefix, filePaths] of groups) {
      const [keySymbols, calleeFiles] = await Promise.all([
        store.symbols.getKeySymbolsInFilePaths(filePaths, maxKeySymbols),
        store.callEdges.getDependencyFilesForFilePaths(filePaths),
      ])

      const dependsOn = new Set<string>()
      for (const { file_path } of calleeFiles) {
        const g = filePathToTopDir(file_path)
        dependsOn.add(g)
      }

      groupInfo.set(prefix, { filePaths, keySymbols, dependsOn })
    }

    const allGroupKeys = [...groups.keys()]
    const layerOf = new Map<string, number>()

    const computeLayer = (g: string, visiting = new Set<string>()): number => {
      if (layerOf.has(g)) return layerOf.get(g)!
      if (visiting.has(g)) return 0
      visiting.add(g)
      const knownDeps = [...(groupInfo.get(g)?.dependsOn ?? [])].filter((d) =>
        allGroupKeys.includes(d),
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

    const out: string[] = []
    out.push(
      `Codebase Map  ${allFiles.length} files · ${allGroupKeys.length} modules · depth=${maxDepth}`,
    )
    out.push('')
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
    out.push('Dependency graph:')
    for (let l = maxLayer; l >= 1; l--) {
      for (const g of (layerBuckets.get(l) ?? []).sort()) {
        const deps = [...(groupInfo.get(g)?.dependsOn ?? [])].sort().join(', ')
        out.push(`  ${g.padEnd(28)} →  ${deps || '(none)'}`)
      }
    }
    out.push('')
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
          const [top, ...rest] = info.keySymbols as [SymRow, ...SymRow[]]
          const topLabel = `${top.name} [${top.kind}]${top.call_count ? ' ×' + top.call_count : ''}`
          const oneLiner = top.docstring
            ?.replace(/^\/\*\*\s*|\s*\*\/$/g, '')
            .split('\n')[0]
            ?.trim()
          out.push(oneLiner ? `  ${topLabel}: ${oneLiner}` : `  ${topLabel}`)
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
    await updateUsage(
      'explore_architecture',
      allFiles.map((f) => f.path),
      output.length,
    )
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error building codebase map: ${err}` }],
      isError: true,
    }
  }
}

/** Lists top-level exported symbols, optionally filtered to true entry points. */
async function entryPoints(
  store: IndexerDB,
  kind?: Array<(typeof ENTRY_KINDS)[number]>,
  file_pattern?: string,
  exclude_tests = true,
  only_unreferenced = false,
): Promise<ToolResult> {
  try {
    const kinds = kind ?? [...ENTRY_KINDS]

    let results = await store.symbols.getEntrypointSymbols(kinds)

    if (exclude_tests) {
      const testFileGlobs = getTestFileGlobs()
      results = results.filter(
        (s) => !doesPathMatch(testFileGlobs, s.file_path),
      )
    }

    if (only_unreferenced) {
      const allImportedNames = await store.imports.getAll()
      const importedNameSet = new Set(
        allImportedNames
          .map((i) => i.importedNames)
          .flat()
          .filter(Boolean),
      )
      results = results.filter((s) => !importedNameSet.has(s.name))
    }

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No exported entry points found${only_unreferenced ? ' (all exports are imported by other files)' : ''}.`,
          },
        ],
      }
    }

    const byFile = new Map<string, typeof results>()
    for (const sym of results) {
      if (file_pattern && !sym.file_path.includes(file_pattern)) {
        continue
      }

      const group = byFile.get(sym.file_path) ?? []
      group.push(sym)
      byFile.set(sym.file_path, group)
    }

    const sections = [...byFile.entries()].map(([filePath, syms]) => {
      const symLines = syms.map((s) => {
        let line = `  [${s.kind}] ${s.name} (line ${s.line + 1})`
        if (s.signature) line += ` → ${s.signature}`
        if (s.docstring) line += `\n    Doc: ${s.docstring.split('\n')[0]}`
        return line
      })
      return `${filePath}\n${symLines.join('\n')}`
    })

    const flags = [
      exclude_tests ? 'excluding tests' : 'including tests',
      only_unreferenced ? 'unreferenced only' : null,
    ]
      .filter(Boolean)
      .join(', ')

    const header = `Entry Points (${flags})\nTotal: ${results.length} symbol${results.length !== 1 ? 's' : ''} across ${byFile.size} file${byFile.size !== 1 ? 's' : ''}\n`

    const output = header + '\n' + sections.join('\n\n')
    await updateUsage('explore_architecture', [...byFile.keys()], output.length)
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error getting entry points: ${err}` }],
      isError: true,
    }
  }
}

/** Renders a Mermaid call-graph of the codebase. */
async function explore(
  store: IndexerDB,
  file_pattern?: string,
  kind?: Array<(typeof ENTRY_KINDS)[number]>,
  include_unresolved = false,
  max_nodes = 80,
): Promise<ToolResult> {
  try {
    const maxNodes = max_nodes ?? 80
    const includeUnresolved = include_unresolved ?? false

    const entryPointGlobs = getEntryPointGlobs()
    const CALLABLE_KINDS = await allCallableKinds()
    const CONTAINER_KINDS = await allContainerKinds()
    const DEFAULT_KINDS = Array.from(
      new Set([...CALLABLE_KINDS, ...CONTAINER_KINDS]),
    ).sort()

    const activeKinds = kind?.length ? kind : DEFAULT_KINDS

    const [allSymbols, allFiles] = await Promise.all([
      store.symbols.getAll(),
      store.files.getAll(),
    ])

    const entryPointFiles = new Set(
      allFiles
        .filter((f) => doesPathMatch(entryPointGlobs, f.path))
        .map((f) => f.path),
    )

    const candidateSymbols = allSymbols.filter((s) => {
      if (!activeKinds.includes(s.kind)) {
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

    const allEdges = await store.callEdges.getAllEdgesWithSiteInfo()

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

    const candidateIds = new Set(candidateSymbols.map((s) => s.id))
    type EdgeRecord = { callerId: string; calleeId: string; callerFile: string }
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

    const ghostNodes = new Map<string, string>()
    const ghostEdges: { callerId: string; ghostId: string }[] = []
    if (includeUnresolved) {
      const unresolvedEdges =
        await store.callEdges.getAllEdgesWithSiteInfo(true)
      for (const e of unresolvedEdges) {
        if (!keptNodes.has(e.caller_id)) continue
        const ghostId =
          ghostNodes.get(e.callee_name) ?? `ghost_${toNodeId(e.callee_name)}`
        ghostNodes.set(e.callee_name, ghostId)
        ghostEdges.push({ callerId: e.caller_id, ghostId })
      }
    }

    const keptSymbols = sortedCandidates.slice(0, maxNodes)
    const parentIds = [
      ...new Set(
        keptSymbols
          .map((s) => s.parent_id)
          .filter((id): id is string => id != null),
      ),
    ]
    const parentSymbols =
      parentIds.length > 0 ? await store.symbols.getSymbolsByIds(parentIds) : []
    const containerById = new Map(
      parentSymbols
        .filter((p) => CONTAINER_KINDS.includes(p.kind))
        .map((p) => [p.id, p]),
    )

    type ContainerGroup = {
      sym: schema.IndexedSymbol['Select']
      children: schema.IndexedSymbol['Select'][]
    }
    type FileGroup = {
      containers: Map<string, ContainerGroup>
      orphans: schema.IndexedSymbol['Select'][]
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

    const lines: string[] = ['graph LR']
    let sgIdx = 0

    const renderNode = (sym: (typeof keptSymbols)[0], indent: string): void => {
      const nodeId = toNodeId(sym.id)
      const label = truncate(`${sym.kind} ${sym.name}`)
      const isEntry = entryPointFiles.has(sym.file_path)
      if (isEntry) {
        lines.push(`${indent}${nodeId}[/"${label}"/]`)
      } else if (sym.exported) {
        lines.push(`${indent}${nodeId}["${label}"]`)
      } else {
        lines.push(`${indent}${nodeId}(["${label}"])`)
      }
    }

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
      lines.push(`  subgraph ${sgId}["${isEntryFile ? '‼️ ' : ''}${label}"]`)
      for (const sym of fg.orphans) renderNode(sym, '    ')
      for (const [, ctr] of fg.containers) {
        const ctrSgId = `sg${sgIdx++}`
        const ctrLabel = truncate(`${ctr.sym.kind} ${ctr.sym.name}`)
        lines.push(`    subgraph ${ctrSgId}["${ctrLabel}"]`)
        for (const child of ctr.children) renderNode(child, '      ')
        lines.push('    end')
      }
      lines.push('  end')
    }

    if (ghostNodes.size > 0) {
      lines.push('  subgraph ghost["External / Unresolved"]')
      for (const [name, ghostId] of ghostNodes) {
        lines.push(`    ${ghostId}["${truncate(name)}"]:::ghost`)
      }
      lines.push('  end')
    }

    const seenEdges = new Set<string>()
    for (const e of filteredEdges) {
      const key = `${e.callerId}→${e.calleeId}`
      if (seenEdges.has(key)) continue
      seenEdges.add(key)
      const onTrace =
        reachableFromEntry.has(e.callerId) && reachableFromEntry.has(e.calleeId)
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

    lines.push(
      '  classDef ghost fill:#f5f5f5,stroke:#aaa,color:#999,stroke-dasharray:4',
    )
    lines.push(
      '  classDef entry fill:#fef3c7,stroke:#f59e0b,color:#92400e,font-weight:bold',
    )
    lines.push('  classDef reachable fill:#dbeafe,stroke:#3b82f6,color:#1e3a8a')

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

    await updateUsage('explore_architecture', orderedFiles, summary.length)
    return { content: [{ type: 'text', text: summary }] }
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `explore_architecture failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    }
  }
}

/** Computes Robert C. Martin's coupling metrics for each file. */
async function couplingMetrics(
  store: IndexerDB,
  sort_by: (typeof SORT_OPTIONS)[number],
  limit: number,
  min_symbols: number,
  file_pattern?: string,
): Promise<ToolResult> {
  try {
    const sortKey = sort_by ?? 'distance'
    const maxLimit = limit ?? 30
    const minSymbols = min_symbols ?? 1

    let allFiles = await store.files.getAll()
    if (file_pattern) {
      allFiles = allFiles.filter((f) => f.path.includes(file_pattern))
    }

    const filePathSet = new Set(allFiles.map((f) => f.path))
    const allImports = await store.imports.getAll()
    const allSymbols = await store.symbols.getAll()

    const ceMap = new Map<string, Set<string>>()
    const caMap = new Map<string, Set<string>>()

    for (const imp of allImports) {
      if (
        !filePathSet.has(imp.file_path) ||
        !filePathSet.has(imp.sourceModule)
      ) {
        continue
      }
      if (imp.file_path === imp.sourceModule) continue
      const ce = ceMap.get(imp.file_path) ?? new Set<string>()
      ce.add(imp.sourceModule)
      ceMap.set(imp.file_path, ce)
      const ca = caMap.get(imp.sourceModule) ?? new Set<string>()
      ca.add(imp.file_path)
      caMap.set(imp.sourceModule, ca)
    }

    const abstractKinds = new Set<string>([
      SymbolKind.interface,
      SymbolKind.type,
    ])
    type Counts = { total: number; abstract: number }
    const symbolCounts = new Map<string, Counts>()
    for (const sym of allSymbols) {
      const counts = symbolCounts.get(sym.file_path) ?? {
        total: 0,
        abstract: 0,
      }
      counts.total++
      if (abstractKinds.has(sym.kind)) counts.abstract++
      symbolCounts.set(sym.file_path, counts)
    }

    type FileMetrics = {
      file: string
      Ce: number
      Ca: number
      I: number
      A: number
      D: number
      totalSymbols: number
    }
    const metrics: FileMetrics[] = []
    for (const file of allFiles) {
      const counts = symbolCounts.get(file.path) ?? { total: 0, abstract: 0 }
      if (counts.total < minSymbols) continue
      const Ce = ceMap.get(file.path)?.size ?? 0
      const Ca = caMap.get(file.path)?.size ?? 0
      const I = Ce + Ca > 0 ? Ce / (Ce + Ca) : 0
      const A = counts.total > 0 ? counts.abstract / counts.total : 0
      const D = Math.abs(A + I - 1)
      metrics.push({
        file: file.path,
        Ce,
        Ca,
        I,
        A,
        D,
        totalSymbols: counts.total,
      })
    }

    if (metrics.length === 0) {
      return {
        content: [
          { type: 'text', text: 'No files with symbols found in the index.' },
        ],
      }
    }

    metrics.sort((a, b) => {
      switch (sortKey) {
        case 'distance':
          return b.D - a.D
        case 'instability':
          return b.I - a.I
        case 'afferent':
          return b.Ca - a.Ca
        case 'efferent':
          return b.Ce - a.Ce
      }
    })

    const topMetrics = metrics.slice(0, maxLimit)
    const header = `${'Ce'.padStart(4)}  ${'Ca'.padStart(4)}  ${'I'.padStart(6)}  ${'A'.padStart(6)}  ${'D'.padStart(6)}  File`
    const separator = '─'.repeat(80)
    const rows = topMetrics.map(
      (m) =>
        `${String(m.Ce).padStart(4)}  ${String(m.Ca).padStart(4)}  ${m.I.toFixed(2).padStart(6)}  ${m.A.toFixed(2).padStart(6)}  ${m.D.toFixed(2).padStart(6)}  ${m.file}`,
    )

    const lines = [
      `Coupling metrics for ${topMetrics.length} of ${metrics.length} files (sorted by ${sortKey}):\n`,
      header,
      separator,
      ...rows,
      '',
      'Ce=efferent, Ca=afferent, I=instability (0=stable,1=unstable), A=abstractness, D=distance from main sequence',
      'High D + high I + low A = Zone of Pain (concrete and depended-upon). High D + low I + high A = Zone of Uselessness.',
    ]

    const output = lines.join('\n')
    await updateUsage(
      'explore_architecture',
      metrics.map((m) => m.file),
      output.length,
    )
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [
        { type: 'text', text: `Error computing coupling metrics: ${err}` },
      ],
      isError: true,
    }
  }
}

function toNodeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_')
}

function truncate(s: string, max = 80): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}
