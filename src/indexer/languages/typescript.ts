import type { Node } from 'web-tree-sitter'
import type { IndexedSymbol, SymbolKind } from '../types'
import { randomUUID } from 'crypto'

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

function addSymbol(
  node: Node,
  nameNode: Node | null,
  kind: SymbolKind,
  parentId?: string,
): string | null {
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
    filePath,
    line: node.startPosition.row,
    column: node.startPosition.column,
    endLine: node.endPosition.row,
    endColumn: node.endPosition.column,
    signature,
    docstring: getDocstring(node),
    parentId,
    exported: isNodeExported,
  })

  return id
}

function traverse(node: Node, currentParentId?: string) {
  let nextParentId = currentParentId

  switch (node.type) {
    case 'class_declaration': {
      const nameNode = node.childForFieldName('name')
      nextParentId = addSymbol(node, nameNode, 'class') || currentParentId
      break
    }
    case 'method_definition': {
      const nameNode = node.childForFieldName('name')
      // Methods belong to classes, so use currentParentId
      addSymbol(node, nameNode, 'method', currentParentId)
      // We don't change nextParentId because nested functions inside methods don't become direct children in our simple model
      break
    }
    case 'function_declaration': {
      const nameNode = node.childForFieldName('name')
      addSymbol(node, nameNode, 'function', currentParentId)
      break
    }
    case 'lexical_declaration':
    case 'variable_declaration': {
      // Find variable declarators
      const declarators = node.namedChildren.filter(
        (c) => c.type === 'variable_declarator',
      )
      for (const decl of declarators) {
        const nameNode = decl.childForFieldName('name')
        const valueNode = decl.childForFieldName('value')

        if (
          valueNode &&
          (valueNode.type === 'arrow_function' || valueNode.type === 'function')
        ) {
          addSymbol(node, nameNode, 'function', currentParentId)
        } else {
          // Only add top-level or exported variables
          if (isExported(node) || !currentParentId) {
            addSymbol(node, nameNode, 'variable', currentParentId)
          }
        }
      }
      break
    }
    case 'interface_declaration': {
      const nameNode = node.childForFieldName('name')
      addSymbol(node, nameNode, 'interface', currentParentId)
      break
    }
    case 'type_alias_declaration': {
      const nameNode = node.childForFieldName('name')
      addSymbol(node, nameNode, 'type', currentParentId)
      break
    }
    case 'enum_declaration': {
      const nameNode = node.childForFieldName('name')
      addSymbol(node, nameNode, 'enum', currentParentId)
      break
    }
  }

  if (node?.namedChildren) {
    for (const child of node.namedChildren) {
      traverse(child, nextParentId)
    }
  }
}

export function extractTypeScriptSymbols(
  rootNode: Node,
  filePath: string,
): IndexedSymbol['Select'][] {
  const symbols: IndexedSymbol['Select'][] = []

  if (rootNode) {
    traverse(rootNode)
  }

  return symbols
}
