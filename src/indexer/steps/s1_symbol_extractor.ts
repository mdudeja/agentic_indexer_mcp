import type { Node } from 'web-tree-sitter'
import {
  SymbolKind,
  type IndexedSymbol,
  type IndexedImport,
  type IndexedSymbolCall,
  type LanguageConfig,
  DocstringStrategy,
} from '../../config/types'
import { randomUUIDv7, hash } from 'bun'
import { AppStateManager } from 'src/state'
import { resolveImportedModulePath } from 'src/utils/paths'
import { getCommentText } from '../docstrings/formatComment'
import { InheritenceType } from 'src/database/schemas/common.schema'

type TreesitterConfig = LanguageConfig['treesitter']

const symbols: IndexedSymbol['Select'][] = []
const imports: IndexedImport['Select'][] = []
const calls: IndexedSymbolCall['Insert'][] = []

/** Check if a given node is marked as exported based on its parent's type in the provided configuration. */
function isExported(node: Node, config: TreesitterConfig): boolean {
  const parent = node.parent
  return parent !== null && config.lists.exported_nodes.includes(parent.type)
}

/** Retrieves and returns the docstring comment associated with a given syntax tree node based on configured strategy. If strategy is 'either', it checks before first. */
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

  let docStringNode: Node | null = null
  let strategyUsed = 'previous'

  if (nodeInfo.docstring === DocstringStrategy.either) {
    docStringNode = targetNode.previousNamedSibling
    if (!docStringNode || !docStringNode.type.includes('comment')) {
      docStringNode = targetNode.nextNamedSibling
      strategyUsed = 'next'
    }
  }

  if (nodeInfo.docstring === DocstringStrategy.comment_before) {
    docStringNode = targetNode.previousNamedSibling
  }

  if (nodeInfo.docstring === DocstringStrategy.comment_after) {
    docStringNode = targetNode.nextNamedSibling
    strategyUsed = 'next'
  }

  if (!docStringNode) return undefined

  if (
    Math.abs(docStringNode.endPosition.row - targetNode.startPosition.row) > 1
  ) {
    return undefined
  }

  const comments: string[] = []

  while (docStringNode && docStringNode.type.includes('comment')) {
    comments.unshift(docStringNode.text.trim())
    docStringNode =
      strategyUsed === 'previous'
        ? docStringNode.previousNamedSibling
        : docStringNode.nextNamedSibling
  }

  return comments.length > 0 ? getCommentText(comments.join('\n')) : undefined
}

/** "Retrieves and concatenates all decorators associated with a node and its preceding siblings." */
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

/** Builds a signature string by extracting relevant text from a node, considering its type and configuration settings. If the extracted text is too long, it truncates it to fit within a specified limit. */
function buildSignature(node: Node, config: TreesitterConfig): string | null {
  const isTypedef = config.lists.typedef_nodes.includes(node.type)
  const raw = isTypedef
    ? node.text.trim()
    : (node.text.split(config.block_init_marker)[0]?.trim() ?? '')
  if (!raw) return null
  return raw.length > config.signature_max_length
    ? raw.substring(0, config.signature_max_length - 3) + '...'
    : raw
}

/** Extract the simple type name from a type_identifier or generic_type node (e.g. "Map" from "Map<string,number>"). */
function extractTypeName(node: Node): string | null {
  if (node.type === 'type_identifier') return node.text
  if (node.type === 'identifier') return node.text
  if (node.type === 'generic_type') {
    const typeId = node.namedChildren.find(
      (c) => c?.type === 'type_identifier' || c?.type === 'identifier',
    )
    return typeId?.text ?? null
  }
  return null
}

/** Registers a new code symbol in the symbol database. */
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

  // Extract inheritance details (extends / implements) when config declares a heritage_node type
  let inherits_from_names: string | null = null
  let inheritence_type: InheritenceType | null = null
  const nodeInfo = config.nodes_info[node.type]
  if (nodeInfo?.heritage_node) {
    const heritageNode = node.namedChildren.find(
      (c) => c?.type === nodeInfo.heritage_node,
    )
    if (heritageNode) {
      const extendsClause = heritageNode.namedChildren.find(
        (c) => c?.type === 'extends_clause',
      )
      if (extendsClause) {
        const typeNode = extendsClause.namedChildren[0]
        if (typeNode) {
          inherits_from_names = extractTypeName(typeNode)
          inheritence_type = InheritenceType.extends
        }
      }
      const implementsClause = heritageNode.namedChildren.find(
        (c) => c?.type === 'implements_clause',
      )
      if (implementsClause) {
        const names = implementsClause.namedChildren
          .map((c) => (c ? extractTypeName(c) : null))
          .filter((n): n is string => n !== null)
        if (names.length > 0) inherits_from_names = names.join(',')
        inheritence_type = InheritenceType.implements
      }
    }
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
    signature: buildSignature(node, config),
    parameters_json: null,
    return_type: null,
    docstring: getDocstring(node, config) ?? null,
    parent_id: parent_id ?? null,
    inheritence_type,
    inherits_from_names,
    exported: isExported(node, config),
    decorator: getDecorators(node),
    language,
  })

  return id
}

/** Processes import statements by extracting module paths and imported names, recording them for further use. */
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

/** Processes variable declarations (const/let/var) by extracting and recording their names as symbols in the project. */
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

/** Records a function call by extracting the callee name and logging relevant details such as caller, language, location, and file path. */
function recordCall(
  config: TreesitterConfig,
  node: Node,
  currentCallerId: string,
  languageName: string,
  file_path: string,
  call_text: string,
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
      caller_id: currentCallerId,
      callee_name: calleeName,
      language_name: languageName,
      call_line: node.startPosition.row,
      call_column: node.startPosition.column,
      caller_file_path: file_path,
      call_text,
      docstring: getDocstring(node, config) ?? null,
    })
  }
}

/** Recursively processes each node in a syntax tree to index symbols, their kinds (e.g., const, function), and call expressions, using configuration settings to determine how to handle different node types. */
function traverse(
  node: Node,
  file_path: string,
  config: TreesitterConfig,
  currentParentId?: string,
  currentCallerId?: string,
) {
  let nextParentId = currentParentId
  let nextCallerId = currentCallerId

  if (node.type === 'call_expression' && currentCallerId) {
    const call_text = node.text.trim()
    recordCall(
      config,
      node,
      currentCallerId,
      config?.language_name ?? 'unknown',
      file_path,
      call_text,
    )
  }

  const nodeInfo = config?.nodes_info?.[node.type]

  if (nodeInfo) {
    const kind = nodeInfo.kind

    if (kind === SymbolKind.import) {
      handleImport(node, file_path, nodeInfo)
    } else if (
      kind === SymbolKind.const ||
      kind === SymbolKind.let ||
      kind === SymbolKind.var
    ) {
      handleVariableDeclaration(node, file_path, config!, currentParentId)
    } else if (kind && kind !== SymbolKind.decorator) {
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
          nextCallerId = newSymbolId
        }
      }
    }
  }

  if (node?.namedChildren) {
    for (const child of node.namedChildren) {
      if (!child) continue
      traverse(child, file_path, config, nextParentId, nextCallerId)
    }
  }
}

/** Extracts and collects symbols, imports, and calls from the provided AST (root node) based on the given configuration, returning them for further processing or analysis. */
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
    // Create a synthetic module-level symbol so top-level call expressions
    // (e.g. `const X = parseLogLevel(...)`) have a valid caller_id.
    const appConfig = AppStateManager.getInstance().getItem('config')
    const fileExtn = file_path.split('.').pop() ?? ''
    const language = appConfig?.extnToLangMap[fileExtn] ?? 'unknown'
    const moduleName = file_path.split('/').pop() ?? file_path
    const moduleSymbolId = `${hash(`${file_path}:${moduleName}:module:0:0`)}`
    symbols.push({
      id: moduleSymbolId,
      name: moduleName,
      kind: SymbolKind.module,
      file_path,
      line: 0,
      column: 0,
      end_line: rootNode.endPosition.row,
      end_column: rootNode.endPosition.column,
      signature: null,
      parameters_json: null,
      return_type: null,
      docstring: null,
      parent_id: null,
      inheritence_type: null,
      inherits_from_names: null,
      exported: false,
      decorator: null,
      language,
    })
    traverse(rootNode, file_path, config, undefined, moduleSymbolId)
  }

  return {
    symbols: [...symbols],
    imports: [...imports],
    calls: [...calls],
  }
}
