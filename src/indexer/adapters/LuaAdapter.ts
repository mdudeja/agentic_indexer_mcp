import type { Node, QueryMatch } from 'web-tree-sitter'
import { SymbolKind } from '../../config/types'
import {
  type LanguageAdapter,
  type ExtractionResult,
  extractCallDocstring,
} from './LanguageAdapter'
import { randomUUIDv7 } from 'bun'
import { hashSymbol } from 'src/utils/hashers'

export class LuaAdapter implements LanguageAdapter {
  extract(matches: QueryMatch[], file_path: string): ExtractionResult {
    const result: ExtractionResult = {
      symbols: [],
      imports: [],
      calls: [],
      exceptions: [],
      envVars: [],
    }

    const nodeToSymbolId = new Map<number, string>()

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

    return result
  }

  private handleSymbolCapture(
    captureName: string,
    node: Node,
    file_path: string,
    result: ExtractionResult,
    nodeToSymbolId: Map<number, string>,
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

    const id = hashSymbol({
      name: nameNode.text,
      kind,
      file_path,
      line: targetNode.startPosition.row,
      column: targetNode.startPosition.column,
      signature: targetNode.text.slice(0, 100),
    })

    let parent_id: string | null = null
    let p = targetNode.parent
    while (p) {
      if (nodeToSymbolId.has(p.id)) {
        parent_id = nodeToSymbolId.get(p.id)!
        break
      }
      p = p.parent
    }

    nodeToSymbolId.set(targetNode.id, id)

    result.symbols.push({
      id,
      name: nameNode.text,
      kind,
      file_path,
      line: targetNode.startPosition.row,
      column: targetNode.startPosition.column,
      end_line: targetNode.endPosition.row,
      end_column: targetNode.endPosition.column,
      signature: targetNode.text,
      parameters_json: null,
      return_type: null,
      docstring: null,
      parent_id,
      inheritence_type: null,
      inherits_from_names: null,
      exported: true,
      decorator: null,
      language: 'lua',
    })
  }

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
    })
  }

  private handleImportCapture(
    node: Node,
    file_path: string,
    result: ExtractionResult,
  ) {
    result.imports.push({
      id: randomUUIDv7(),
      file_path,
      module_path: node.parent?.text ?? 'unknown', // simplified for lua require
      imported_name: null,
    })
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
      name: node.text, // Simplified
      line: node.startPosition.row,
      column: node.startPosition.column,
    })
  }
}
