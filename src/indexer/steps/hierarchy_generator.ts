import type {
  IndexedSymbol,
  LanguageConfig,
  NodeInfo,
} from '../../config/types'

type TreesitterConfig = LanguageConfig['treesitter']
type ListName = keyof TreesitterConfig['lists']

/**
 * A node in the cross-file hierarchy graph.
 *
 * `members` — structurally contained children (from parent_id, driven by container_nodes).
 * `calls`   — reserved for future call-graph edges driven by callable_nodes.
 */
export type HierarchyNode = {
  id: string
  name: string
  kind: string
  file_path: string
  line: number
  end_line: number | null | undefined
  exported: boolean
  members: HierarchyNode[]
  calls: HierarchyNode[]
}

export type HierarchyGraph = {
  /** Top-level nodes with no structural parent. */
  roots: HierarchyNode[]
  /** Full id→node map for O(1) lookup. */
  nodeMap: Map<string, HierarchyNode>
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a reverse map: SymbolKind value → list name in config.lists.
 * Used to determine how a given symbol should participate in the hierarchy.
 */
export function buildKindToListMap(
  config: TreesitterConfig,
): Map<string, ListName> {
  const map = new Map<string, ListName>()
  const { nodes_info, lists } = config

  for (const listName of Object.keys(lists) as ListName[]) {
    for (const nodeType of lists[listName]) {
      const info: NodeInfo | undefined = nodes_info[nodeType]
      if (info?.kind[0] !== undefined) {
        // First kind entry wins; a kind should only appear in one list
        if (!map.has(info.kind[0])) {
          map.set(info.kind[0], listName)
        }
      }
    }
  }

  return map
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a cross-file hierarchy graph from all indexed symbols.
 *
 * The config `lists` drive how each symbol participates:
 * - `container_nodes`  → establish structural parent scope; their children become `members`
 * - `callable_nodes`   → reserved for future call-graph edges
 * - `typedef_nodes`    → appear as `members` of their container
 * - `decorator_nodes`  → appear as `members` of their container
 * - `additional_nodes` → appear as `members` of their container (leaf nodes)
 */
export function buildHierarchy(
  symbols: IndexedSymbol['Select'][],
): HierarchyGraph {
  const nodeMap = new Map<string, HierarchyNode>()

  for (const sym of symbols) {
    nodeMap.set(sym.id, {
      id: sym.id,
      name: sym.name,
      kind: sym.kind,
      file_path: sym.file_path,
      line: sym.line,
      end_line: sym.end_line,
      exported: sym.exported ?? false,
      members: [],
      calls: [],
    })
  }

  // --- Wire structural members via parent_id ---

  const roots: HierarchyNode[] = []
  for (const sym of symbols) {
    const node = nodeMap.get(sym.id)!
    if (sym.parent_id && nodeMap.has(sym.parent_id)) {
      nodeMap.get(sym.parent_id)!.members.push(node)
    } else {
      roots.push(node)
    }
  }

  return { roots, nodeMap }
}
