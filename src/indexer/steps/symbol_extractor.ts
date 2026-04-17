import type { Node } from 'web-tree-sitter'
import { SymbolKind, type IndexedSymbol, type IndexedImport, type SymbolReference } from '../../config/types'
import { randomUUID } from 'crypto'

const symbols: IndexedSymbol['Select'][] = []
const imports: IndexedImport['Select'][] = []
const references: SymbolReference['Select'][] = []

function isExported(node: Node): boolean {
  let current: Node | null = node.parent
  while (current) {
    if (
      current.type === 'export_statement' ||
      current.type === 'export_default_declaration'
    ) {
      return true
    }
    current = current.parent
  }
  return false
}

function getDocstring(node: Node): string | undefined {
  // Look at previous sibling. If it's a comment, extract it.
  // In tree-sitter an export_statement wraps the declaration, so check the export statement's sibling if exported
  const targetNode = node.parent?.type.includes('export') ? node.parent : node
  const prev = targetNode.previousNamedSibling
  if (prev && prev.type === 'comment') {
    return prev.text
  }
  return undefined
}

function addSymbol({
  node,
  nameNode,
  kind,
  parent_id,
  file_path,
}: {
  node: Node
  nameNode: Node | null
  kind: SymbolKind
  parent_id?: string
  file_path: string
}): string | null {
  if (!nameNode) return null

  const id = randomUUID()
  const isNodeExported = isExported(node)

  // Default to full node text for signature, truncate if too long
  let signature = node.text.split('{')[0]?.trim()
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
    docstring: getDocstring(node) ?? null,
    parent_id: parent_id ?? null,
    exported: isNodeExported,
  })

  return id
}

function traverse(node: Node, file_path: string, config?: any, currentParentId?: string) {
  let nextParentId = currentParentId

  if (node.type === 'import_statement') {
    const sourceNode = node.childForFieldName('source')
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
  } else if (node.type === 'call_expression') {
    const functionNode = node.childForFieldName('function')
    if (functionNode) {
      references.push({
        id: randomUUID(),
        file_path,
        caller_symbol_id: currentParentId ?? null,
        callee_name: functionNode.text,
      })
    }
  } else if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const declarators = node.namedChildren.filter(
      (c) => c?.type === 'variable_declarator',
    )
    for (const decl of declarators) {
      if (!decl) continue
      const nameNode = decl.childForFieldName('name')
      const valueNode = decl.childForFieldName('value')

      if (
        valueNode &&
        (valueNode.type === 'arrow_function' || valueNode.type === 'function')
      ) {
        addSymbol({
          node: decl,
          nameNode,
          kind: SymbolKind.function,
          parent_id: currentParentId,
          file_path,
        })
      } else {
        if (isExported(node) || !currentParentId) {
          addSymbol({
            node: decl,
            nameNode,
            kind: SymbolKind.var,
            parent_id: currentParentId,
            file_path,
          })
        }
      }
    }
  } else if (config?.nodes_info?.[node.type]) {
    const nodeConfig = config.nodes_info[node.type]
    const nameNode = nodeConfig.name_field ? node.childForFieldName(nodeConfig.name_field) : null
    
    const kind = nodeConfig.kind[0]

    const newSymbolId = addSymbol({
      node,
      nameNode,
      kind,
      parent_id: currentParentId,
      file_path,
    })

    if (newSymbolId && config.container_nodes?.includes(node.type)) {
      nextParentId = newSymbolId
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
  config?: any,
): { symbols: IndexedSymbol['Select'][]; imports: IndexedImport['Select'][]; references: SymbolReference['Select'][] } {
  // Clear previous results
  symbols.length = 0
  imports.length = 0
  references.length = 0

  if (rootNode) {
    traverse(rootNode, file_path, config)
  }

  return { symbols: [...symbols], imports: [...imports], references: [...references] }
}
