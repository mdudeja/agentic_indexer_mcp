import type { IndexedSymbol, LanguageConfig, NodeInfo } from '../../config/types'
import { AppStateManager } from 'src/state'
import { IndexerDB } from '../../database/IndexerDB'

type TreesitterConfig = LanguageConfig['treesitter']
type ListName = keyof TreesitterConfig['lists']

export type HierarchyNode = {
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

export type HierarchyGraph = {
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
export type HierarchyScope =
  | { type: 'file'; file_path: string }
  | { type: 'symbol'; symbol_id: string }
  | { type: 'codebase' }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a reverse map: SymbolKind value → list name in config.lists.
 * All kind entries per node type are mapped (not just kind[0]), so that
 * both `let` and `const` (which share a lexical_declaration node) are covered.
 */
export function buildKindToListMap(
  config: TreesitterConfig,
): Map<string, ListName> {
  const map = new Map<string, ListName>()
  const { nodes_info, lists } = config

  for (const listName of Object.keys(lists) as ListName[]) {
    for (const nodeType of lists[listName]) {
      const info: NodeInfo | undefined = nodes_info[nodeType]
      if (!info) continue
      for (const kind of info.kind) {
        if (!map.has(kind)) {
          map.set(kind, listName)
        }
      }
    }
  }

  return map
}

/**
 * Return the treesitter config for the first configured language.
 * Used to derive the kind→list classification when no language is specified.
 * In a multi-language project this can be made smarter per-symbol.
 */
function getFirstLangConfig(): TreesitterConfig | undefined {
  const config = AppStateManager.getInstance().getItem('config')
  if (!config) return undefined
  const first = Object.values(config.languages)[0]
  return first?.treesitter
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
export async function buildHierarchy(
  scope: HierarchyScope,
): Promise<HierarchyGraph> {
  const db = IndexerDB.getInstance()
  const langConfig = getFirstLangConfig()
  const kindToList = langConfig
    ? buildKindToListMap(langConfig)
    : new Map<string, ListName>()

  // --- Fetch symbols for the requested scope ---
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

  // --- Build nodeMap ---
  const nodeMap = new Map<string, HierarchyNode>()
  for (const sym of symbols) {
    nodeMap.set(sym.id, {
      id: sym.id,
      name: sym.name,
      kind: sym.kind,
      category: kindToList.get(sym.kind) ?? null,
      file_path: sym.file_path,
      line: sym.line,
      end_line: sym.end_line,
      exported: sym.exported ?? false,
      members: [],
      calls: [],
    })
  }

  // --- Wire children to parents; anything without a parent in the set is a root ---
  const roots: HierarchyNode[] = []
  for (const sym of symbols) {
    const node = nodeMap.get(sym.id)!
    if (sym.parent_id && nodeMap.has(sym.parent_id)) {
      nodeMap.get(sym.parent_id)!.members.push(node)
    } else {
      roots.push(node)
    }
  }

  // --- Resolve call edges within the fetched scope ---
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

  // --- Sort members and roots by source line for stable, readable ordering ---
  for (const node of nodeMap.values()) {
    node.members.sort((a, b) => a.line - b.line)
    node.calls.sort((a, b) => a.line - b.line)
  }
  roots.sort((a, b) => a.line - b.line)

  return { roots, nodeMap }
}
