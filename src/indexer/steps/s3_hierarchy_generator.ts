import type { IndexedSymbol, NodeInfo } from '../../config/types'
import { AppStateManager } from 'src/state'
import { IndexerDB } from '../../database/IndexerDB'
import type { ListName, TreesitterConfig } from 'src/state/types'
import { logInfo, logWarning } from 'src/utils/logger'

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

/** Populates the global state with kind-to-list maps for the specified languages if they are not already present. */
function checkAndPopulateKindToListMaps(languages: string[]) {
  const stateManager = AppStateManager.getInstance()
  let globalKindToListMap =
    stateManager.getItem('kindToListMap') ??
    new Map<string, Map<string, ListName>>()

  for (const lang of languages) {
    if (!globalKindToListMap.has(lang)) {
      const langConfig = getLangConfig(lang)
      if (langConfig) {
        const kindToList = buildKindToListMap(langConfig)
        globalKindToListMap.set(lang, kindToList)
        logInfo(`Populated kind→list map for language: ${lang}`)
      } else {
        logWarning(
          `No config found for language: ${lang}, kind→list mapping will be unavailable for this language.`,
        )
      }
    }
  }

  stateManager.setItem('kindToListMap', globalKindToListMap)
}

/** Retrieves the mapping of node kinds to list names for the specified language from the application state manager. */
function getKindToListMap(lang: string): Map<string, ListName> | undefined {
  const stateManager = AppStateManager.getInstance()
  const globalKindToListMap = stateManager.getItem('kindToListMap')
  return globalKindToListMap?.get(lang)
}

/**
 * Return the treesitter config for the first configured language.
 * Used to derive the kind→list classification when no language is specified.
 * In a multi-language project this can be made smarter per-symbol.
 */
function getLangConfig(lang: string): TreesitterConfig | undefined {
  const config = AppStateManager.getInstance().getItem('config')
  if (!config) return undefined
  const langConfig = config.languages[lang]
  return langConfig?.treesitter
}

/** Retrieves the unique programming languages associated with a given hierarchy scope, such as a specific file, symbol, or the entire codebase. */
async function getLanguagesInScope(
  scope: HierarchyScope,
): Promise<(string | null)[]> {
  const db = IndexerDB.getInstance()

  switch (scope.type) {
    case 'file': {
      const file = await db.getFileByPath(scope.file_path)
      return file ? [file.language] : []
    }

    case 'symbol': {
      const symbol = await db.getSymbolsByIds([scope.symbol_id])
      if (symbol.length === 0) return []
      return [symbol[0]!.language]
    }

    case 'codebase': {
      const files = await db.getAllFiles()
      const languages = Array.from(
        new Set(files.map((f) => f.language).filter((l): l is string => !!l)),
      )
      return languages
    }
  }
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

  const languagesInScope = await getLanguagesInScope(scope)
  checkAndPopulateKindToListMaps(
    languagesInScope.filter((l): l is string => !!l),
  )

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
      category: getKindToListMap(sym.language)?.get(sym.kind) ?? null,
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
