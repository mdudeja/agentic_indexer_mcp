import type { Node } from 'web-tree-sitter'
import {
  SymbolKind,
  type IndexedSymbol,
  type IndexedImport,
  type LanguageConfig,
} from '../../config/types'
import { randomUUID } from 'crypto'

type TreesitterConfig = LanguageConfig['treesitter']

const symbols: IndexedSymbol['Select'][] = []
const imports: IndexedImport['Select'][] = []

function isExported(node: Node, config: TreesitterConfig): boolean {
  let current: Node | null = node.parent
  while (current) {
    if (config.lists.exported_nodes.includes(current.type)) {
      return true
    }
    current = current.parent
  }
  return false
}

function getDocstring(
  node: Node,
  config: TreesitterConfig,
): string | undefined {
  const targetNode = node.parent?.type.includes('export') ? node.parent : node
  const nodeInfo = config.nodes_info[targetNode.type]
  if (!nodeInfo || !nodeInfo.docstring) return undefined

  let docStringNode =
    nodeInfo.docstring === 'comment_before'
      ? targetNode.previousNamedSibling
      : targetNode.nextNamedSibling
  if (!docStringNode) return undefined

  const comments: string[] = []

  while (docStringNode && docStringNode.type.includes('comment')) {
    comments.unshift(docStringNode.text.trim())
    docStringNode =
      nodeInfo.docstring === 'comment_before'
        ? docStringNode.previousNamedSibling
        : docStringNode.nextNamedSibling
  }

  if (comments.length > 0) {
    return comments.join('\n')
  }

  return undefined
}

function addSymbol({
  node,
  nameNode,
  kind,
  parent_id,
  file_path,
  config,
}: {
  node: Node
  nameNode: Node | null
  kind: SymbolKind
  parent_id?: string
  file_path: string
  config: TreesitterConfig
}): string | null {
  if (!nameNode) return null

  const id = randomUUID()
  const isNodeExported = isExported(node, config)

  let signature = node.text.split(config.block_init_marker)[0]?.trim()
  if (signature && signature.length > 200) {
    signature = signature.substring(0, 197) + '...'
  }

  symbols.push({
    id,
    name: nameNode.text,
    kind,
    file_path,
    line: node.startPosition.row,
    column: node.startPosition.column,
    end_line: node.endPosition.row,
    end_column: node.endPosition.column,
    signature: signature ?? null,
    docstring: getDocstring(node, config) ?? null,
    parent_id: parent_id ?? null,
    exported: isNodeExported,
    decorator: null,
  })

  return id
}

function traverse(
  node: Node,
  file_path: string,
  config?: TreesitterConfig,
  currentParentId?: string,
) {
  let nextParentId = currentParentId

  const nodeInfo = config?.nodes_info?.[node.type]

  if (nodeInfo) {
    const kind = nodeInfo.kind[0]
    if (kind === undefined) {
      // Malformed config entry — skip but still recurse into children
    } else if (kind === SymbolKind.import) {
      // Imports go to the imports table via source_field
      const sourceField = nodeInfo.source_field ?? 'source'
      const sourceNode = node.childForFieldName(sourceField)
      if (sourceNode) {
        let moduleName = sourceNode.text
        if (moduleName.startsWith("'") || moduleName.startsWith('"')) {
          moduleName = moduleName.substring(1, moduleName.length - 1)
        }
        imports.push({
          id: randomUUID(),
          file_path,
          module_name: moduleName,
          imported_name: null,
        })
      }
    } else {
      let nameNode = nodeInfo.name_field
        ? node.childForFieldName(nodeInfo.name_field)
        : null

      // For nodes that don't carry their own name (e.g. arrow functions assigned
      // to a variable), inherit the name from the parent variable_declarator.
      if (!nameNode && nodeInfo.inherit_name_from_parent) {
        const parent = node.parent
        if (parent?.type === 'variable_declarator') {
          nameNode = parent.childForFieldName('name')
        }
      }

      const newSymbolId = addSymbol({
        node,
        nameNode,
        kind,
        parent_id: currentParentId,
        file_path,
        config,
      })

      // Container nodes (classes, modules, namespaces…) establish the parent
      // scope for all of their descendants, building the full hierarchy
      if (newSymbolId && config?.lists?.container_nodes?.includes(node.type)) {
        nextParentId = newSymbolId
      }
    }
  }

  if (node?.namedChildren) {
    for (const child of node.namedChildren) {
      if (!child) continue
      traverse(child, file_path, config, nextParentId)
    }
  }
}

export function extractSymbols(
  rootNode: Node,
  file_path: string,
  config?: TreesitterConfig,
): {
  symbols: IndexedSymbol['Select'][]
  imports: IndexedImport['Select'][]
} {
  symbols.length = 0
  imports.length = 0

  if (rootNode) {
    traverse(rootNode, file_path, config)
  }

  return {
    symbols: [...symbols],
    imports: [...imports],
  }
}
