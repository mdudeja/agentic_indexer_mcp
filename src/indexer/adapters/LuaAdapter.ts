import type { Node, QueryMatch } from 'web-tree-sitter'
import { SymbolKind } from '../../config/types'
import {
  type LanguageAdapter,
  type ExtractionResult,
  extractCallDocstring,
} from './LanguageAdapter'
import { randomUUIDv7 } from 'bun'
import { hashSymbol } from 'src/utils/hashers'

/** Extracts and processes code elements (such as symbols, imports, calls, exceptions, and environment variables) from Lua files using query matches. Constructs an ExtractionResult containing extracted information for further analysis or documentation generation. */
export class LuaAdapter implements LanguageAdapter {
  /** Extracts relevant code elements (such as symbols, docstrings, calls, imports, exceptions, and environment variables) from query matches within a specified file. The method processes these elements to construct an ExtractionResult containing extracted information for further analysis or documentation generation. */
  extract(matches: QueryMatch[], file_path: string): ExtractionResult {
    const result: ExtractionResult = {
      symbols: [],
      imports: [],
      calls: [],
      exceptions: [],
      envVars: [],
      explicitExports: [],
    }

    const nodeToSymbolId = new Map<number, string>()
    const anonScopeSymbols = new Set<string>()

    matches.sort((a, b) => a.patternIndex - b.patternIndex)

    // Pre first pass to gather exports
    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.name.startsWith('export')) {
          const capturedNode = capture.node
          if (!capturedNode) continue
          let text = capturedNode.text
          if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1)
          else if (text.startsWith("'") && text.endsWith("'")) text = text.slice(1, -1)
          result.explicitExports.push({
            id: randomUUIDv7(),
            file_path,
            name: text,
            line: capturedNode.startPosition.row,
            column: capturedNode.startPosition.column,
            end_line: capturedNode.endPosition.row,
            end_column: capturedNode.endPosition.column,
            decorator: null,
            docstring: null,
            exported: true,
            inheritence: null,
            kind: SymbolKind.export,
            language: 'lua',
            parent_id: null,
            signature: null,
            parameters_json: null,
            return_type: null,
          })
        }
      }
    }

    // First pass: extract symbols
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
            symbol.docstring = docstringCaptures
              .map((c) => c.node.text)
              .join('\n')
          }
        }
      }
    }

    // Third pass: extract calls, imports, exceptions, envVars
    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.name.startsWith('call.')) {
          this.handleCallCapture(
            capture.node,
            file_path,
            result,
            nodeToSymbolId,
          )
        } else if (capture.name.startsWith('import.')) {
          this.handleImportCapture(capture.node, file_path, result)
        } else if (capture.name.startsWith('exception.')) {
          this.handleExceptionCapture(
            capture.node,
            file_path,
            result,
            nodeToSymbolId,
          )
        } else if (capture.name.startsWith('env.')) {
          this.handleEnvCapture(capture.node, file_path, result, nodeToSymbolId)
        }
      }
    }

    return this.cleanUpLexicals(result, anonScopeSymbols)
  }

  /** Captures and processes symbol declarations in Lua code by handling nodes in the Abstract Syntax Tree (AST). It extracts information such as name, type, location, and parent relationships to build a comprehensive index of project symbols. */
  private handleSymbolCapture(
    captureName: string,
    node: Node,
    file_path: string,
    result: ExtractionResult,
    nodeToSymbolId: Map<number, string>,
    anonScopeSymbols: Set<string>,
  ) {
    let kind: SymbolKind | undefined
    let nameNode: Node | null = null
    let targetNode: Node = node

    if (captureName === 'symbol.function.decl') {
      return
    } else if (captureName === 'symbol.function.name') {
      kind = SymbolKind.function
      targetNode = node.parent!
      nameNode = node
    } else if (captureName === 'symbol.var.decl') {
      return
    } else if (captureName === 'symbol.var.name') {
      kind = SymbolKind.var
      targetNode = node.parent!
      nameNode = node
    }

    if (!kind || !nameNode) return

    const signature = this.generateSignature(targetNode)

    const id = hashSymbol({
      name: nameNode.text,
      kind,
      file_path,
      line: targetNode.startPosition.row,
      column: targetNode.startPosition.column,
      signature: targetNode.text,
    })

    const ANON_SCOPE_TYPES = new Set(['function_definition'])
    let parent_id: string | null = null
    let insideAnonScope = false
    let p = targetNode.parent
    while (p) {
      if (nodeToSymbolId.has(p.id)) {
        parent_id = nodeToSymbolId.get(p.id)!
        break
      }
      insideAnonScope = ANON_SCOPE_TYPES.has(p.type) || insideAnonScope
      p = p.parent
    }

    nodeToSymbolId.set(targetNode.id, id)
    if (insideAnonScope) {
      anonScopeSymbols.add(id)
    }

    const exported = targetNode.parent?.type === 'chunk' && !nameNode.text.startsWith('_')

    result.symbols.push({
      id,
      name: nameNode.text,
      kind,
      file_path,
      line: targetNode.startPosition.row,
      column: targetNode.startPosition.column,
      end_line: targetNode.endPosition.row,
      end_column: targetNode.endPosition.column,
      signature: signature,
      parameters_json: null,
      return_type: null,
      docstring: null,
      parent_id,
      inheritence: null,
      exported,
      decorator: null,
      language: 'lua',
    })
  }

  /** Captures and records function call details in Lua code, tracking caller information and call context. */
  private handleCallCapture(
    node: Node,
    file_path: string,
    result: ExtractionResult,
    nodeToSymbolId: Map<number, string>,
  ) {
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
    while (callExpr && callExpr.type !== 'function_call') {
      callExpr = callExpr.parent
    }
    const callText = callExpr ? callExpr.text : (node.parent?.text ?? node.text)

    result.calls.push({
      id: randomUUIDv7(),
      caller_id,
      callee_name: node.text,
      language_name: 'lua',
      call_line: node.startPosition.row,
      call_column: node.startPosition.column,
      caller_file_path: file_path,
      call_text: callText,
      docstring: extractCallDocstring(callExpr || node),
      is_lang_feature: false,
    })
  }

  /** Captures import information when handling nodes during processing, adding each import to the extraction result with a unique identifier, file path, and module path. */
  private handleImportCapture(
    node: Node,
    file_path: string,
    result: ExtractionResult,
  ) {
    let modulePath = 'unknown'
    let importedName: string | null = null

    const argsNode = node.children.find(c => c?.type === 'arguments')
    if (argsNode) {
      const stringNode = argsNode.children.find(c => c?.type === 'string')
      if (stringNode) {
        modulePath = stringNode.text.slice(1, -1)
      }
    }

    let p = node.parent
    while (p) {
      if (p.type === 'variable_declaration') {
        const idNode = p.children.find(c => c?.type === 'identifier')
        if (idNode) importedName = idNode.text
        break
      } else if (p.type === 'assignment_statement') {
        const varList = p.children.find(c => c?.type === 'variable_list')
        if (varList) {
          const idNode = varList.children.find(c => c?.type === 'identifier')
          if (idNode) importedName = idNode.text
        }
        break
      }
      p = p.parent
    }

    result.imports.push({
      id: randomUUIDv7(),
      file_path,
      module_path: modulePath,
      imported_name: importedName,
    })
  }

  /** Captures exception details during node processing, adding them to the extraction result with relevant metadata. */
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

  /** Captures environment variable references within AST nodes and records them in the extraction result. */
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

  /** Cleans up the extraction results by removing unnecessary lexical symbols. Specifically targets variables declared in anonymous scope or under callable parents to prevent redundant references. */
  private cleanUpLexicals(
    result: ExtractionResult,
    anonScopeSymbols: Set<string>,
  ) {
    const lexicalKinds = [SymbolKind.var]
    const callableKinds = [SymbolKind.function]

    const toRemoveIds = new Set<string>()

    for (const symbol of result.symbols) {
      const parentId = symbol.parent_id
      const isParentExported = parentId
        ? result.symbols.some((s) => s.id === parentId && s.exported)
        : false
      
      if (
        !lexicalKinds.includes(symbol.kind) ||
        symbol.exported ||
        isParentExported
      )
        continue

      const hasCallableParent =
        anonScopeSymbols.has(symbol.id) ||
        (symbol.parent_id
          ? result.symbols.some(
              (s) =>
                s.id === symbol.parent_id && callableKinds.includes(s.kind) && !s.exported,
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

  /** Generates a signature string for a given AST node by analyzing its text content, removing function bodies. */
  private generateSignature(node: Node): string {
    const lines = node.text.split('\n')
    if (lines.length > 0) {
      return lines[0]!.trim()
    }
    return node.text.slice(0, 100).trim()
  }
}
