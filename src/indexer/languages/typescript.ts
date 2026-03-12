import type { Node } from 'web-tree-sitter'
import { SymbolKind, type IndexedSymbol } from '../../config/types'
import { randomUUID } from 'crypto'

const symbols: IndexedSymbol['Select'][] = []

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

function traverse(node: Node, file_path: string, currentParentId?: string) {
  let nextParentId = currentParentId

  switch (node.type) {
    case 'class_declaration': {
      const nameNode = node.childForFieldName('name')
      nextParentId =
        addSymbol({
          node,
          nameNode,
          kind: SymbolKind.class,
          parent_id: currentParentId,
          file_path,
        }) || currentParentId
      break
    }
    case 'method_definition': {
      const nameNode = node.childForFieldName('name')
      // Methods belong to classes, so use currentParentId
      addSymbol({
        node,
        nameNode,
        kind: SymbolKind.method,
        parent_id: currentParentId,
        file_path,
      })
      // We don't change nextParentId because nested functions inside methods don't become direct children in our simple model
      break
    }
    case 'function_declaration': {
      const nameNode = node.childForFieldName('name')
      addSymbol({
        node,
        nameNode,
        kind: SymbolKind.function,
        parent_id: currentParentId,
        file_path,
      })
      break
    }
    case 'lexical_declaration':
    case 'variable_declaration': {
      // Find variable declarators
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
          // Only add top-level or exported variables
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
      break
    }
    case 'interface_declaration': {
      const nameNode = node.childForFieldName('name')
      addSymbol({
        node,
        nameNode,
        kind: SymbolKind.interface,
        parent_id: currentParentId,
        file_path,
      })
      break
    }
    case 'type_alias_declaration': {
      const nameNode = node.childForFieldName('name')
      addSymbol({
        node,
        nameNode,
        kind: SymbolKind.type,
        parent_id: currentParentId,
        file_path,
      })
      break
    }
    case 'enum_declaration': {
      const nameNode = node.childForFieldName('name')
      addSymbol({
        node,
        nameNode,
        kind: SymbolKind.enum,
        parent_id: currentParentId,
        file_path,
      })
      break
    }
  }

  if (node?.namedChildren) {
    for (const child of node.namedChildren) {
      if (!child) continue
      traverse(child, file_path, nextParentId)
    }
  }
}

export function extractTypeScriptSymbols(
  rootNode: Node,
  file_path: string,
): IndexedSymbol['Select'][] {
  // Clear previous results
  symbols.length = 0

  if (rootNode) {
    traverse(rootNode, file_path)
  }

  return symbols
}
