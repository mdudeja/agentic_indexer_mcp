import type { Node } from 'web-tree-sitter'
import {
  SymbolKind,
  type IndexedSymbol,
  type IndexedImport,
  type IndexedSymbolCall,
  type LanguageConfig,
} from '../../config/types'
import { randomUUIDv7, hash } from 'bun'
import { AppStateManager } from 'src/state'
import { resolveImportedModulePath } from 'src/utils/paths'

type TreesitterConfig = LanguageConfig['treesitter']

const symbols: IndexedSymbol['Select'][] = []
const imports: IndexedImport['Select'][] = []
const calls: IndexedSymbolCall['Insert'][] = []

/** Checks if the given node is exported by verifying if its parent type is included in the configuration's exported nodes list. */
function isExported(node: Node, config: TreesitterConfig): boolean {
  const parent = node.parent
  return parent !== null && config.lists.exported_nodes.includes(parent.type)
}

/** Extracts the documentation comments associated with a syntax node by traversing its adjacent comment siblings as defined in the configuration. */
function getDocstring(
  node: Node,
  config: TreesitterConfig,
): string | undefined {
  let targetNode: Node | null = node

  if (node.type === 'arrow_function') {
    // For arrow functions, check if the parent variable_declarator has a docstring, since the function itself won't have one.
    const parent = node.parent
    if (parent?.type === 'variable_declarator') {
      targetNode = parent.parent
    }
  }

  if (!targetNode) return undefined

  if (
    targetNode.parent?.type.includes('export') ||
    targetNode.parent?.type.includes('ambient')
  ) {
    targetNode = targetNode.parent
  }

  const nodeInfo = config.nodes_info[node.type]
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

  return comments.length > 0 ? comments.join('\n') : undefined
}

// Collect @decorator names for a node and return them as a comma-joined string.
// Two placements exist in the TS grammar:
//   - named children of the node itself (class_declaration keeps decorators inside)
//   - preceding named siblings (method_definition / public_field_definition have their
//     decorators as siblings in the containing class_body, not as children)
function getDecorators(node: Node): string | null {
  const names: string[] = []

  for (const child of node.namedChildren) {
    if (!child || child.type !== 'decorator') continue
    const text = child.text
      .slice(1)
      .replace(/\([\s\S]*\)$/, '')
      .trim()
    if (text) names.push(text)
  }

  const siblingDecorators: string[] = []
  let prev = node.previousNamedSibling
  while (prev?.type === 'decorator') {
    const text = prev.text
      .slice(1)
      .replace(/\([\s\S]*\)$/, '')
      .trim()
    if (text) siblingDecorators.unshift(text)
    prev = prev.previousNamedSibling
  }
  names.push(...siblingDecorators)

  return names.length > 0 ? names.join(', ') : null
}

// Build a signature string for a node.
// For typedef nodes (type alias, interface, enum) the full text is the definition,
// so we keep it instead of truncating at '{'.
function buildSignature(node: Node, config: TreesitterConfig): string | null {
  const isTypedef = config.lists.typedef_nodes.includes(node.type)
  const raw = isTypedef
    ? node.text.trim()
    : (node.text.split(config.block_init_marker)[0]?.trim() ?? '')
  if (!raw) return null
  return raw.length > 200 ? raw.substring(0, 197) + '...' : raw
}

/** Adds a code symbol to the registry by extracting metadata from the provided node and returns a unique hash-based identifier. */
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

  const appConfig = AppStateManager.getInstance().getItem('config')
  const fileExtn = file_path.split('.').pop() ?? ''
  const language = appConfig?.extnToLangMap[fileExtn] ?? 'unknown'

  const id = `${hash(
    `${file_path}:${nameNode.text}:${kind}:${node.startPosition.row}:${node.startPosition.column}`,
  )}`

  symbols.push({
    id,
    name: nameNode.text,
    kind,
    file_path,
    line: node.startPosition.row,
    column: node.startPosition.column,
    end_line: node.endPosition.row,
    end_column: node.endPosition.column,
    signature: buildSignature(node, config),
    parameters_json: null,
    return_type: null,
    docstring: getDocstring(node, config) ?? null,
    parent_id: parent_id ?? null,
    exported: isExported(node, config),
    decorator: getDecorators(node),
    language,
  })

  return id
}

// Handle import_statement: extract one record per imported name so that
// `import { useState, useEffect } from 'react'` produces two records.
function handleImport(
  node: Node,
  file_path: string,
  nodeInfo: { source_field?: string },
) {
  const sourceField = nodeInfo.source_field ?? 'source'
  const sourceNode = node.childForFieldName(sourceField)
  if (!sourceNode) return

  let moduleName = sourceNode.text
  if (moduleName.startsWith("'") || moduleName.startsWith('"')) {
    moduleName = moduleName.slice(1, -1)
  }

  const importClause = node.namedChildren.find(
    (c) => c?.type === 'import_clause',
  )
  if (!importClause) {
    // bare side-effect import: import 'module'
    imports.push({
      id: randomUUIDv7(),
      file_path: file_path,
      module_path: resolveImportedModulePath(moduleName, file_path),
      imported_name: null,
    })
    return
  }

  const importedNames: string[] = []

  for (const child of importClause.namedChildren) {
    if (!child) continue
    if (child.type === 'identifier') {
      // default import: import Foo from 'module'
      importedNames.push(child.text)
    } else if (child.type === 'named_imports') {
      // named imports: import { Foo, Bar as B } from 'module'
      for (const specifier of child.namedChildren) {
        if (!specifier || specifier.type !== 'import_specifier') continue
        const nameNode = specifier.childForFieldName('name')
        if (nameNode) importedNames.push(nameNode.text)
      }
    } else if (child.type === 'namespace_import') {
      // namespace import: import * as Foo from 'module'
      const nameNode = child.namedChildren.find((c) => c?.type === 'identifier')
      if (nameNode) importedNames.push('* as ' + nameNode.text)
    }
  }

  if (importedNames.length === 0) {
    imports.push({
      id: randomUUIDv7(),
      file_path: file_path,
      module_path: resolveImportedModulePath(moduleName, file_path),
      imported_name: null,
    })
  } else {
    for (const name of importedNames) {
      imports.push({
        id: randomUUIDv7(),
        file_path: file_path,
        module_path: resolveImportedModulePath(moduleName, file_path),
        imported_name: name,
      })
    }
  }
}

// Handle lexical_declaration (const/let) and variable_declaration (var).
// These wrap one or more variable_declarator children and the keyword ('const',
// 'let', 'var') must be read from the first child token, not from the config kind array.
function handleVariableDeclaration(
  node: Node,
  file_path: string,
  config: TreesitterConfig,
  currentParentId?: string,
) {
  const keyword = node.children[0]?.type // 'const' | 'let' | 'var'
  const kind =
    keyword === 'const'
      ? SymbolKind.const
      : keyword === 'let'
        ? SymbolKind.let
        : SymbolKind.var

  for (const child of node.namedChildren) {
    if (!child || child.type !== 'variable_declarator') continue
    const nameNode = child.childForFieldName('name')
    addSymbol({
      node,
      nameNode,
      kind,
      parent_id: currentParentId,
      file_path,
      config,
    })
  }
}

/** Extracts the callee name from a syntax node and records call metadata, including location and caller ID, to the calls collection. */
function recordCall(
  node: Node,
  currentCallableId: string,
  languageName: string,
  file_path: string,
) {
  const funcNode = node.childForFieldName('function')
  if (!funcNode) return
  let calleeName: string | null = null
  if (funcNode.type === 'identifier') {
    calleeName = funcNode.text
  } else if (funcNode.type === 'member_expression') {
    const prop = funcNode.childForFieldName('property')
    calleeName = prop?.text ?? null
  }
  if (calleeName) {
    calls.push({
      id: randomUUIDv7(),
      caller_id: currentCallableId,
      callee_name: calleeName,
      language_name: languageName,
      call_line: node.startPosition.row,
      call_column: node.startPosition.column,
      caller_file_path: file_path,
    })
  }
}

/** Recursively traverses a syntax tree to index symbols and record call expressions based on configuration while maintaining hierarchical context. */
function traverse(
  node: Node,
  file_path: string,
  config: TreesitterConfig,
  currentParentId?: string,
  currentCallableId?: string,
) {
  let nextParentId = currentParentId
  let nextCallableId = currentCallableId

  if (node.type === 'call_expression' && currentCallableId) {
    recordCall(
      node,
      currentCallableId,
      config?.language_name ?? 'unknown',
      file_path,
    )
  }

  const nodeInfo = config?.nodes_info?.[node.type]

  if (nodeInfo) {
    const kind = nodeInfo.kind
    if (kind === undefined) {
      // Malformed config entry — skip but still recurse into children
    } else if (kind === SymbolKind.import) {
      handleImport(node, file_path, nodeInfo)
    } else if (kind === SymbolKind.decorator) {
      // Decorators are attached to their parent symbol via getDecorators(); skip standalone indexing
    } else if (
      kind === SymbolKind.const ||
      kind === SymbolKind.let ||
      kind === SymbolKind.var
    ) {
      handleVariableDeclaration(node, file_path, config!, currentParentId)
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
        config: config!,
      })

      if (newSymbolId) {
        if (config?.lists?.container_nodes?.includes(node.type)) {
          nextParentId = newSymbolId
        }
        if (config?.lists?.callable_nodes?.includes(node.type)) {
          nextCallableId = newSymbolId
        }
      }
    }
  }

  if (node?.namedChildren) {
    for (const child of node.namedChildren) {
      if (!child) continue
      traverse(child, file_path, config, nextParentId, nextCallableId)
    }
  }
}

/** Extracts symbols, imports, and function calls from a tree-sitter root node by traversing it according to the provided configuration and file path. */
export function extractSymbols(
  rootNode: Node,
  file_path: string,
  config: TreesitterConfig,
): {
  symbols: IndexedSymbol['Select'][]
  imports: IndexedImport['Select'][]
  calls: IndexedSymbolCall['Insert'][]
} {
  symbols.length = 0
  imports.length = 0
  calls.length = 0

  if (rootNode) {
    traverse(rootNode, file_path, config)
  }

  return {
    symbols: [...symbols],
    imports: [...imports],
    calls: [...calls],
  }
}
