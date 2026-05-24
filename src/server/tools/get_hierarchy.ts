import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { AppStateManager } from 'src/state'
import type { IndexedSymbol, NodeInfo } from '../../config/types'
import type { ListName, TreesitterConfig } from 'src/state/types'

type HierarchyNode = {
  id: string
  name: string
  kind: string
  /** Which config list category this symbol belongs to (callable, container, typedef, etc.) */
  category: ListName | null
  file_path: string
  line: number
  end_line: number | null | undefined
  exported: boolean
  members: HierarchyNode[]
  calls: HierarchyNode[]
}

type HierarchyGraph = {
  /** Top-level nodes with no structural parent in the fetched set. */
  roots: HierarchyNode[]
  /** Full id→node map for O(1) lookup. */
  nodeMap: Map<string, HierarchyNode>
}

/**
 * Describes which symbols to include in the hierarchy.
 *
 * - `file`     — all symbols in a single file
 * - `symbol`   — a single symbol and all its descendants (recursive)
 * - `codebase` — every indexed symbol
 */
type HierarchyScope =
  | { type: 'file'; file_path: string }
  | { type: 'symbol'; symbol_id: string }
  | { type: 'codebase' }

/**
 * Build a reverse map: SymbolKind value → list name in config.lists.
 * All kind entries per node type are mapped (not just kind[0]), so that
 * both `let` and `const` (which share a lexical_declaration node) are covered.
 */
function buildKindToListMap(config: TreesitterConfig): Map<string, ListName> {
  const map = new Map<string, ListName>()
  const { nodes_info, lists } = config
  for (const listName of Object.keys(lists) as ListName[]) {
    for (const nodeType of lists[listName]) {
      const info: NodeInfo | undefined = nodes_info[nodeType as string]
      if (!info) continue
      for (const kind of info.kind) {
        if (!map.has(kind)) map.set(kind, listName)
      }
    }
  }
  return map
}

/** Ensures each specified language has its kind-to-list mapping in the global map. */
function ensureKindToListMaps(languages: string[]) {
  const stateManager = AppStateManager.getInstance()
  const globalMap =
    stateManager.getItem('kindToListMap') ??
    new Map<string, Map<string, ListName>>()
  const config = stateManager.getItem('config')
  for (const lang of languages) {
    if (!globalMap.has(lang)) {
      const langConfig = config?.languages[lang]?.treesitter
      if (langConfig) globalMap.set(lang, buildKindToListMap(langConfig))
    }
  }
  stateManager.setItem('kindToListMap', globalMap)
}

/** Retrieves the mapping of node kinds for the specified programming language. Returns the corresponding map if it exists. */
function getKindToListMap(lang: string): Map<string, ListName> | undefined {
  return AppStateManager.getInstance().getItem('kindToListMap')?.get(lang)
}

/** Returns the set of unique programming languages used in the specified scope (file, symbol, or entire codebase). */
async function getLanguagesInScope(scope: HierarchyScope): Promise<string[]> {
  const db = IndexerDB.getInstance()
  switch (scope.type) {
    case 'file': {
      const file = await db.getFileByPath(scope.file_path)
      return file?.language ? [file.language] : []
    }
    case 'symbol': {
      const syms = await db.getSymbolsByIds([scope.symbol_id])
      return syms[0]?.language ? [syms[0].language] : []
    }
    case 'codebase': {
      const files = await db.getAllFiles()
      return [
        ...new Set(
          files.map((f) => f.language).filter((l): l is string => !!l),
        ),
      ]
    }
  }
}

/**
 * Assemble an in-memory hierarchy graph for the given scope.
 *
 * Config is read from AppStateManager so callers don't need to thread it through.
 * The config drives:
 *   - `category` on each node (callable / container / typedef / additional / decorator)
 *
 * Scope drives the DB query:
 *   - `file`     → symbols for one file, ordered by line
 *   - `symbol`   → symbol + all descendants via recursive parent_id walk
 *   - `codebase` → all symbols, ordered by file then line
 */
async function buildHierarchy(scope: HierarchyScope): Promise<HierarchyGraph> {
  const db = IndexerDB.getInstance()
  const langs = await getLanguagesInScope(scope)
  ensureKindToListMaps(langs)

  let symbols: IndexedSymbol['Select'][]
  switch (scope.type) {
    case 'file':
      symbols = await db.getSymbolsForFile(scope.file_path)
      break
    case 'symbol':
      symbols = await db.getSymbolSubtree(scope.symbol_id)
      break
    case 'codebase':
      symbols = await db.getAllSymbols()
      break
  }

  const nodeMap = new Map<string, HierarchyNode>()
  for (const sym of symbols) {
    nodeMap.set(sym.id, {
      id: sym.id,
      name: sym.name,
      kind: sym.kind,
      category: getKindToListMap(sym.language)?.get(sym.kind) ?? null,
      file_path: sym.file_path,
      line: sym.line,
      end_line: sym.end_line,
      exported: sym.exported ?? false,
      members: [],
      calls: [],
    })
  }

  const roots: HierarchyNode[] = []
  for (const sym of symbols) {
    const node = nodeMap.get(sym.id)!
    if (sym.parent_id && nodeMap.has(sym.parent_id)) {
      nodeMap.get(sym.parent_id)!.members.push(node)
    } else {
      roots.push(node)
    }
  }

  if (nodeMap.size > 0) {
    const nameToNodes = new Map<string, HierarchyNode[]>()
    for (const node of nodeMap.values()) {
      const list = nameToNodes.get(node.name) ?? []
      list.push(node)
      nameToNodes.set(node.name, list)
    }
    const callEdges = await db.getCallsForSymbols([...nodeMap.keys()])
    for (const edge of callEdges) {
      const callerNode = nodeMap.get(edge.caller_id)
      if (!callerNode) continue
      for (const callee of nameToNodes.get(edge.callee_name) ?? []) {
        if (callee !== callerNode && !callerNode.calls.includes(callee)) {
          callerNode.calls.push(callee)
        }
      }
    }
  }

  for (const node of nodeMap.values()) {
    node.members.sort((a, b) => a.line - b.line)
    node.calls.sort((a, b) => a.line - b.line)
  }
  roots.sort((a, b) => a.line - b.line)

  return { roots, nodeMap }
}

/** Renders a hierarchical tree structure for a given node and its descendants as a formatted string. Each line represents a node with its name, type, category (if any), export status, and location. The output uses visual connectors ('└─' or '├─') to indicate hierarchy and includes calls and child nodes recursively. */
function renderNode(
  node: HierarchyNode,
  prefix: string,
  isLast: boolean,
): string {
  const connector = isLast ? '└─' : '├─'
  const childPrefix = prefix + (isLast ? '   ' : '│  ')

  const badge = node.exported ? ' [exported]' : ''
  const cat = node.category ? ` (${node.category})` : ''
  const header = `${prefix}${connector} ${node.name} [${node.kind}]${cat}${badge} — :${node.line + 1}`

  const lines: string[] = [header]

  if (node.calls.length > 0) {
    lines.push(
      `${childPrefix}  ↳ calls: ${node.calls.map((c) => c.name).join(', ')}`,
    )
  }

  node.members.forEach((child, i) => {
    lines.push(renderNode(child, childPrefix, i === node.members.length - 1))
  })

  return lines.join('\n')
}

/** Renders a hierarchical graph structure as a formatted string. The function generates a textual tree view based on the provided graph and scope, handling different display requirements for files, symbols, and codebases. If no data exists for the specified scope, it returns an appropriate message indicating the absence of symbols or relevant information. */
function renderGraph(graph: HierarchyGraph, scope: HierarchyScope): string {
  if (graph.roots.length === 0) {
    const label =
      scope.type === 'file'
        ? scope.file_path
        : scope.type === 'symbol'
          ? scope.symbol_id
          : 'codebase'
    return `No symbols found for: ${label}`
  }

  if (scope.type === 'codebase') {
    const byFile = new Map<string, HierarchyNode[]>()
    for (const root of graph.roots) {
      const list = byFile.get(root.file_path) ?? []
      list.push(root)
      byFile.set(root.file_path, list)
    }
    const sections = [...byFile.entries()].map(([filePath, roots]) => {
      const tree = roots
        .map((root, i) => renderNode(root, '  ', i === roots.length - 1))
        .join('\n')
      return `${filePath}\n${tree}`
    })
    const header = `Hierarchy (codebase — ${graph.nodeMap.size} symbols across ${byFile.size} files)\n`
    return header + '\n' + sections.join('\n\n')
  }

  const label = scope.type === 'file' ? scope.file_path : 'symbol subtree'
  const header = `Hierarchy (${label} — ${graph.nodeMap.size} symbol${graph.nodeMap.size !== 1 ? 's' : ''})\n`
  const tree = graph.roots
    .map((root, i) => renderNode(root, '', i === graph.roots.length - 1))
    .join('\n')
  return header + '\n' + tree
}

// --- Tool registration ---

/** Registers a tool to build a structural hierarchy of symbols for a file, a symbol subtree, or the entire codebase. */
export function registerGetHierarchyTool(server: McpServer) {
  server.registerTool(
    'get_hierarchy',
    {
      title: 'Get Hierarchy',
      description:
        'Build a structural hierarchy of symbols — showing parent/member nesting and intra-scope call edges — for a single file, a symbol and all its descendants, or the entire codebase. Use this to understand how a file is organised, how a class is laid out with its methods, or to get a full codebase symbol tree before refactoring.',
      inputSchema: z.object({
        scope: z
          .enum(['file', 'symbol', 'codebase'])
          .describe(
            'What to build the hierarchy for: "file" = all symbols in one file, "symbol" = a symbol and all its nested descendants, "codebase" = every indexed symbol grouped by file',
          ),
        file_path: z
          .string()
          .optional()
          .describe(
            'Required when scope=file. Path to the file relative to the workspace root.',
          ),
        symbol_id: z
          .string()
          .optional()
          .describe(
            'Required when scope=symbol. The symbol ID (use search_symbols to find it).',
          ),
      }),
    },
    async ({ scope, file_path, symbol_id }) => {
      try {
        let hierarchyScope: HierarchyScope
        if (scope === 'file') {
          if (!file_path) {
            return {
              content: [
                { type: 'text', text: 'file_path is required when scope=file' },
              ],
              isError: true,
            }
          }
          hierarchyScope = { type: 'file', file_path }
        } else if (scope === 'symbol') {
          if (!symbol_id) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'symbol_id is required when scope=symbol',
                },
              ],
              isError: true,
            }
          }
          hierarchyScope = { type: 'symbol', symbol_id }
        } else {
          hierarchyScope = { type: 'codebase' }
        }

        const graph = await buildHierarchy(hierarchyScope)
        return {
          content: [{ type: 'text', text: renderGraph(graph, hierarchyScope) }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error building hierarchy: ${err}` }],
          isError: true,
        }
      }
    },
  )
}
