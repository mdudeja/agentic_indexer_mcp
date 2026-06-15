import type { Node, QueryMatch } from 'web-tree-sitter'
import { SymbolKind } from '../../config/types'
import {
  type LanguageAdapter,
  type ExtractionResult,
  extractCallDocstring,
} from './LanguageAdapter'
import { randomUUIDv7 } from 'bun'
import { resolveImportedModulePath } from '../../utils/paths'
import { getCommentText } from '../docstrings/formatComment'
import { hashSymbol } from 'src/utils/hashers'

export class TypescriptAdapter implements LanguageAdapter {
  extract(matches: QueryMatch[], file_path: string): ExtractionResult {
    const result: ExtractionResult = {
      symbols: [],
      imports: [],
      calls: [],
      exceptions: [],
      envVars: [],
    }

    // Maps node ID to symbol ID to quickly find parent_id
    const nodeToSymbolId = new Map<number, string>()

    // Symbols that live inside an anonymous function scope (arrow_function /
    // function_expression not registered in nodeToSymbolId). Their parent_id
    // ends up null even though they are local, so cleanUpLexicals needs this
    // set to handle them correctly.
    const anonScopeSymbols = new Set<string>()

    // First pass: extract symbols to build parent map
    for (const match of matches) {
      for (const capture of match.captures) {
        if (
          capture.name.startsWith('symbol.') &&
          !capture.name.startsWith('symbol.docstring')
        ) {
          this.handleSymbolCapture(
            capture.name,
            capture.node,
            file_path,
            result,
            nodeToSymbolId,
            anonScopeSymbols,
          )
        }
      }
    }

    // Second pass: extract docstrings
    for (const match of matches) {
      const docstringCaptures = match.captures.filter(
        (c) =>
          c.name === 'symbol.docstring' ||
          c.name === 'symbol.docstring.trailing',
      )
      const targetCapture = match.captures.find(
        (c) => c.name === 'symbol.docstring.target',
      )

      if (docstringCaptures.length > 0 && targetCapture) {
        // Enforce trailing comments are on the same line as the declaration's end
        const isTrailing = docstringCaptures.some(
          (c) => c.name === 'symbol.docstring.trailing',
        )
        if (isTrailing) {
          const commentStartLine = docstringCaptures[0]!.node.startPosition.row
          const targetEndLine = targetCapture.node.endPosition.row
          if (commentStartLine !== targetEndLine) {
            continue
          }
        }

        const targetId = nodeToSymbolId.get(targetCapture.node.id)
        if (targetId) {
          const symbol = result.symbols.find((s) => s.id === targetId)
          if (symbol && !symbol.docstring) {
            symbol.docstring = getCommentText(
              docstringCaptures.map((c) => c.node.text).join('\n'),
            )
          }
        }
      }
    }

    // Third pass: extract calls, imports, exceptions, envVars (needs caller context)
    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.name.startsWith('call.')) {
          this.handleCallCapture(
            capture.node,
            file_path,
            result,
            nodeToSymbolId,
          )
        }

        if (capture.name.startsWith('import.')) {
          this.handleImportCapture(capture.node, file_path, result)
        }

        if (capture.name.startsWith('exception.')) {
          this.handleExceptionCapture(
            capture.node,
            file_path,
            result,
            nodeToSymbolId,
          )
        }

        if (capture.name.startsWith('env.')) {
          this.handleEnvCapture(capture.node, file_path, result, nodeToSymbolId)
        }
      }
    }

    const cleanedResult = this.cleanUpLexicals(result, anonScopeSymbols)

    return cleanedResult
  }

  private handleSymbolCapture(
    captureName: string,
    node: Node,
    file_path: string,
    result: ExtractionResult,
    nodeToSymbolId: Map<number, string>,
    anonScopeSymbols: Set<string>,
  ) {
    const blockInitMarker = '{'
    let kind: SymbolKind | undefined
    let nameNode: Node | null = null
    let targetNode: Node = node
    let signature: string | undefined

    switch (captureName) {
      case 'symbol.class':
        kind = SymbolKind.class
        nameNode = node
        targetNode = node.parent!
        signature = targetNode.text.split(blockInitMarker)[0]
        break
      case 'symbol.interface':
        kind = SymbolKind.interface
        nameNode = node
        targetNode = node.parent!
        signature = targetNode.text
        break
      case 'symbol.typeAlias':
        kind = SymbolKind.type
        nameNode = node
        targetNode = node.parent!
        signature = targetNode.text
        break
      case 'symbol.enum':
        kind = SymbolKind.enum
        nameNode = node
        targetNode = node.parent!
        signature = targetNode.text
        break
      case 'symbol.namespace':
        kind = SymbolKind.namespace
        nameNode = node
        targetNode = node.parent!
        signature = targetNode.text.split(blockInitMarker)[0]
        break
      case 'symbol.module':
        kind = SymbolKind.module
        const moduleNode = node.children.find((c) => c?.type === 'module')
        nameNode =
          moduleNode?.children.find(
            (c) => c?.type === 'string' || c?.type === 'identifier',
          ) || node
        targetNode = node
        signature = targetNode.text.split(blockInitMarker)[0]
        break
      case 'symbol.function':
        kind = SymbolKind.function
        nameNode = node
        targetNode = node.parent!
        signature = targetNode.text.split(blockInitMarker)[0]
        break
      case 'symbol.method':
        kind = SymbolKind.method
        nameNode = node
        targetNode = node.parent!
        signature = targetNode.text.split(blockInitMarker)[0]
        break
      case 'symbol.field':
        kind = SymbolKind.property
        nameNode = node
        targetNode = node.parent!
        signature = targetNode.text.split(blockInitMarker)[0]
        break
      case 'symbol.var.decl':
        // The matched node is the declaration, but we captured the name in symbol.var.name
        break
      case 'symbol.var.name':
        targetNode = node.parent! // The declarator
        const declNode = targetNode.parent! // The declaration (lexical or var)

        const valueNode = targetNode.childForFieldName('value')
        if (valueNode && valueNode.type === 'arrow_function') {
          kind = SymbolKind.arrowFunction
        } else {
          kind =
            declNode.type === 'lexical_declaration' &&
            declNode.children[0]?.text === 'const'
              ? SymbolKind.const
              : declNode.children[0]?.text === 'let'
                ? SymbolKind.let
                : SymbolKind.var
        }
        nameNode = node
        targetNode = declNode
        signature = targetNode.text.split(blockInitMarker)[0]
        break
    }

    if (!kind || !nameNode) return

    const id = hashSymbol({
      name: nameNode.text,
      kind,
      file_path,
      line: targetNode.startPosition.row,
      column: targetNode.startPosition.column,
      signature: targetNode.text,
    })

    // Find parent — also detect if we cross an anonymous function boundary
    // (arrow_function / function_expression not in nodeToSymbolId) so that
    // cleanUpLexicals can remove locals that appear to have no registered parent.
    const ANON_SCOPE_TYPES = new Set(['arrow_function', 'function_expression'])
    let parent_id: string | null = null
    let insideAnonScope = false
    let p = targetNode.parent
    while (p) {
      if (nodeToSymbolId.has(p.id)) {
        parent_id = nodeToSymbolId.get(p.id)!
        break
      }
      if (ANON_SCOPE_TYPES.has(p.type)) {
        insideAnonScope = true
        break
      }
      p = p.parent
    }

    nodeToSymbolId.set(targetNode.id, id)

    if (insideAnonScope) {
      anonScopeSymbols.add(id)
    }

    // Simplified extraction for brevity
    result.symbols.push({
      id,
      name: nameNode.text,
      kind,
      file_path,
      line: targetNode.startPosition.row,
      column: targetNode.startPosition.column,
      end_line: targetNode.endPosition.row,
      end_column: targetNode.endPosition.column,
      signature: signature ?? null,
      parameters_json: null,
      return_type: null,
      docstring: null, // simplified
      parent_id,
      inheritence: null,
      exported: targetNode.parent?.type.includes('export') ?? false,
      decorator: null,
      language: 'typescript',
    })
  }

  private handleCallCapture(
    node: Node,
    file_path: string,
    result: ExtractionResult,
    nodeToSymbolId: Map<number, string>,
  ) {
    // find caller
    let caller_id: string | null = null
    let p = node.parent
    while (p) {
      if (nodeToSymbolId.has(p.id)) {
        caller_id = nodeToSymbolId.get(p.id)!
        break
      }
      p = p.parent
    }

    if (!caller_id) return

    let callExpr: Node | null = node.parent
    while (
      callExpr &&
      !['call_expression', 'new_expression'].includes(callExpr.type)
    ) {
      callExpr = callExpr.parent
    }
    const callText = callExpr ? callExpr.text : node.text

    result.calls.push({
      id: randomUUIDv7(),
      caller_id,
      callee_name: node.text,
      language_name: 'typescript',
      call_line: node.startPosition.row,
      call_column: node.startPosition.column,
      caller_file_path: file_path,
      call_text: callText,
      docstring: extractCallDocstring(callExpr || node),
    })
  }

  private handleImportCapture(
    node: Node,
    file_path: string,
    result: ExtractionResult,
  ) {
    const sourceNode = node.childForFieldName('source')
    if (!sourceNode) return
    const moduleName = sourceNode.text.slice(1, -1)

    const importedNames: string[] = []
    const importClause = node.children.find(
      (c) => c && c.type === 'import_clause',
    )

    if (importClause) {
      const defaultImport = importClause.children.find(
        (c) => c && c.type === 'identifier',
      )
      if (defaultImport) importedNames.push(defaultImport.text)

      const namedImports = importClause.children.find(
        (c) => c && c.type === 'named_imports',
      )
      if (namedImports) {
        const specifiers = namedImports.children.filter(
          (c) => c && c.type === 'import_specifier',
        )
        for (const spec of specifiers) {
          if (!spec) continue
          const nameNode =
            spec.childForFieldName('name') ||
            spec.children.find((c) => c && c.type === 'identifier')
          if (nameNode) importedNames.push(nameNode.text)
        }
      }

      const namespaceImport = importClause.children.find(
        (c) => c && c.type === 'namespace_import',
      )
      if (namespaceImport) {
        const idNode = namespaceImport.children.find(
          (c) => c && c.type === 'identifier',
        )
        if (idNode) importedNames.push(idNode.text)
      }
    }

    if (importedNames.length > 0) {
      for (const name of importedNames) {
        const id = randomUUIDv7()
        result.imports.push({
          id,
          file_path,
          module_path: resolveImportedModulePath(moduleName, file_path),
          imported_name: name,
        })
      }
    } else {
      result.imports.push({
        id: randomUUIDv7(),
        file_path,
        module_path: resolveImportedModulePath(moduleName, file_path),
        imported_name: '',
      })
    }
  }

  private handleExceptionCapture(
    node: Node,
    file_path: string,
    result: ExtractionResult,
    nodeToSymbolId: Map<number, string>,
  ) {
    let symbol_id: string | null = null
    let p = node.parent
    while (p) {
      if (nodeToSymbolId.has(p.id)) {
        symbol_id = nodeToSymbolId.get(p.id)!
        break
      }
      p = p.parent
    }
    if (!symbol_id) return

    result.exceptions.push({
      id: randomUUIDv7(),
      symbol_id,
      file_path,
      exception_type: 'Error',
      line: node.startPosition.row,
      column: node.startPosition.column,
    })
  }

  private handleEnvCapture(
    node: Node,
    file_path: string,
    result: ExtractionResult,
    nodeToSymbolId: Map<number, string>,
  ) {
    let symbol_id: string | null = null
    let p = node.parent
    while (p) {
      if (nodeToSymbolId.has(p.id)) {
        symbol_id = nodeToSymbolId.get(p.id)!
        break
      }
      p = p.parent
    }
    if (!symbol_id) return

    result.envVars.push({
      id: randomUUIDv7(),
      symbol_id,
      file_path,
      name: node.text,
      line: node.startPosition.row,
      column: node.startPosition.column,
    })
  }

  private cleanUpLexicals(
    result: ExtractionResult,
    anonScopeSymbols: Set<string>,
  ) {
    const lexicalKinds = [SymbolKind.const, SymbolKind.let, SymbolKind.var]
    const callableKinds = [
      SymbolKind.function,
      SymbolKind.method,
      SymbolKind.arrowFunction,
    ]

    const toRemoveIds = new Set<string>()

    for (const symbol of result.symbols) {
      if (!lexicalKinds.includes(symbol.kind) || symbol.exported) continue

      const hasCallableParent =
        anonScopeSymbols.has(symbol.id) ||
        (symbol.parent_id
          ? result.symbols.some(
              (s) =>
                s.id === symbol.parent_id && callableKinds.includes(s.kind),
            )
          : false)

      if (hasCallableParent) {
        toRemoveIds.add(symbol.id)
      }
    }

    result.symbols = result.symbols.filter(
      (s) => !toRemoveIds.has(s.id) && !toRemoveIds.has(s.parent_id ?? ''),
    )
    result.calls = result.calls.filter((c) =>
      result.symbols.some((s) => s.id === c.caller_id),
    )
    result.exceptions = result.exceptions.filter((e) =>
      result.symbols.some((s) => s.id === e.symbol_id),
    )
    result.envVars = result.envVars.filter((v) =>
      result.symbols.some((s) => s.id === v.symbol_id),
    )

    return result
  }
}
