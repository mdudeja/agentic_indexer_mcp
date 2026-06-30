import type { Node, QueryMatch } from 'web-tree-sitter'
import { SymbolKind } from '../../config/types'
import {
  type LanguageAdapter,
  type ExtractionResult,
  extractCallDocstring,
  seedModuleSymbol,
} from './LanguageAdapter'
import { randomUUIDv7 } from 'bun'
import { hashSymbol } from 'src/utils/hashers'
import { resolveImportedModulePath } from 'src/utils/paths'

/** An adapter class for extracting and categorizing symbols, imports, calls, exceptions, environment variables, and docstrings from Python code. It processes source files to gather metadata about code elements and organizes them into structured results. */
export class PythonAdapter implements LanguageAdapter {
  /** Extracts and categorizes symbols, imports, calls, exceptions, environment variables, and docstrings from a file based on query matches. Returns an object containing the extracted elements organized by type. */
  extract(
    matches: QueryMatch[],
    file_path: string,
    rootNode: Node,
  ): ExtractionResult {
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

    seedModuleSymbol(rootNode, file_path, 'python', nodeToSymbolId, result)

    matches.sort((a, b) => a.patternIndex - b.patternIndex)

    // Pre first pass to gather exports
    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.name.startsWith('export')) {
          const capturedNode = capture.node
          if (!capturedNode) continue
          let text = capturedNode.text
          if (text.startsWith('"') && text.endsWith('"'))
            text = text.slice(1, -1)
          else if (text.startsWith("'") && text.endsWith("'"))
            text = text.slice(1, -1)
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
            language: 'python',
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

    // Second pass: attach decorators to their target symbols
    for (const match of matches) {
      const decoratorCapture = match.captures.find(
        (c) => c.name === 'symbol.decorator',
      )
      const targetCapture = match.captures.find(
        (c) => c.name === 'symbol.decorator.target',
      )
      if (decoratorCapture && targetCapture) {
        const targetId = nodeToSymbolId.get(targetCapture.node.id)
        if (targetId) {
          const symbol = result.symbols.find((s) => s.id === targetId)
          if (symbol) {
            const text = decoratorCapture.node.text
            symbol.decorator = symbol.decorator
              ? symbol.decorator + '\n' + text
              : text
          }
        }
      }
    }

    // Third pass: extract docstrings
    for (const match of matches) {
      const docstringCaptures = match.captures.filter(
        (c) => c.name === 'symbol.docstring',
      )
      const targetCapture = match.captures.find(
        (c) => c.name === 'symbol.docstring.target',
      )

      if (docstringCaptures.length > 0 && targetCapture) {
        const targetId = nodeToSymbolId.get(targetCapture.node.id)
        if (targetId) {
          const symbol = result.symbols.find((s) => s.id === targetId)
          if (symbol && !symbol.docstring) {
            let text = docstringCaptures[0]!.node.text
            if (text.startsWith('"""') && text.endsWith('"""'))
              text = text.slice(3, -3)
            else if (text.startsWith("'''") && text.endsWith("'''"))
              text = text.slice(3, -3)
            else if (text.startsWith('"') && text.endsWith('"'))
              text = text.slice(1, -1)
            else if (text.startsWith("'") && text.endsWith("'"))
              text = text.slice(1, -1)
            symbol.docstring = text.trim()
          }
        }
      }
    }

    // Fourth pass: extract calls, imports, exceptions, envVars
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

  /** Processes and records symbol information captured during code analysis. It identifies symbols such as classes, functions, and variables, calculates unique identifiers based on their metadata, and establishes parent-child relationships between them. This method ensures that each symbol's details are stored for further use in the analysis process. */
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

    if (captureName === 'symbol.class') {
      kind = SymbolKind.class
      nameNode = node
      targetNode = node.parent!
    } else if (captureName === 'symbol.function') {
      nameNode = node
      targetNode = node.parent!
      let parent = targetNode
      while (parent) {
        if (parent.type === 'class_definition') {
          kind = SymbolKind.method
          break
        }
        parent = parent.parent!
      }
      if (!kind) {
        kind = SymbolKind.function
      }
    } else if (captureName === 'symbol.var.decl') {
      return
    } else if (captureName === 'symbol.var.name') {
      kind = SymbolKind.var
      targetNode = node.parent!
      nameNode = node
    } else if (captureName === 'symbol.field') {
      kind = SymbolKind.property
      targetNode = node.parent!
      nameNode = node
    }

    if (!kind || !nameNode) return

    const signature = this.generateSignature(targetNode)

    const id = hashSymbol({
      name: nameNode.text,
      kind,
      file_path,
      line: nameNode.startPosition.row,
      column: nameNode.startPosition.column,
      signature: targetNode.text,
    })

    const ANON_SCOPE_TYPES = new Set(['lambda'])
    let parent_id: string | null = null
    let insideAnonScope = false
    let p = targetNode.parent
    while (p) {
      if (nodeToSymbolId.has(p.id)) {
        parent_id = nodeToSymbolId.get(p.id)!
        if (kind === SymbolKind.property) {
          let classParentId: string | null = parent_id
          while (true) {
            classParentId =
              result.symbols.find((s) => s.id === classParentId)?.parent_id ??
              null
            if (
              classParentId &&
              result.symbols.find((s) => s.id === classParentId)?.kind ===
                SymbolKind.class
            )
              break
          }
          parent_id = classParentId
        }
        break
      }
      insideAnonScope = ANON_SCOPE_TYPES.has(p.type) || insideAnonScope
      p = p.parent
    }

    nodeToSymbolId.set(targetNode.id, id)
    if (insideAnonScope) {
      anonScopeSymbols.add(id)
    }

    const exported =
      (targetNode.parent?.type === 'module' &&
        !nameNode.text.startsWith('_')) ||
      result.explicitExports.some((e) => e.name === nameNode!.text)

    result.symbols.push({
      id,
      name: nameNode.text,
      kind,
      file_path,
      line: nameNode.startPosition.row,
      column: nameNode.startPosition.column,
      end_line: nameNode.endPosition.row,
      end_column: nameNode.endPosition.column,
      signature: signature,
      parameters_json: null,
      return_type: null,
      docstring: null,
      parent_id,
      inheritence: null,
      exported,
      decorator: null,
      language: 'python',
    })
  }

  /** Processes a node to capture call information and record it in the result, including caller and callee details along with relevant context. */
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
    while (callExpr && callExpr.type !== 'call') {
      callExpr = callExpr.parent
    }
    const callText = callExpr ? callExpr.text : (node.parent?.text ?? node.text)

    result.calls.push({
      id: randomUUIDv7(),
      caller_id,
      callee_name: node.text,
      language_name: 'python',
      call_line: node.startPosition.row,
      call_column: node.startPosition.column,
      caller_file_path: file_path,
      call_text: callText,
      docstring: extractCallDocstring(callExpr || node),
      is_lang_feature: false,
    })
  }

  /** Captures import information from a node and stores it in the result. Used to track imported modules during code analysis or processing. */
  private handleImportCapture(
    node: Node,
    file_path: string,
    result: ExtractionResult,
  ) {
    if (node.type === 'import_statement') {
      const imports = node.children.filter(
        (c) => c && (c.type === 'dotted_name' || c.type === 'aliased_import'),
      )
      for (const imp of imports) {
        if (!imp) continue
        if (imp.type === 'dotted_name') {
          result.imports.push({
            id: randomUUIDv7(),
            file_path,
            module_path: imp.text,
            imported_name: imp.text.split('.').pop() || imp.text,
          })
        } else if (imp.type === 'aliased_import') {
          const nameNode = imp.children.find((c) => c?.type === 'dotted_name')
          const aliasNode = imp.children.find((c) => c?.type === 'identifier')
          if (nameNode && aliasNode) {
            result.imports.push({
              id: randomUUIDv7(),
              file_path,
              module_path: nameNode.text,
              imported_name: aliasNode.text,
            })
          }
        }
      }
    } else if (node.type === 'import_from_statement') {
      const moduleNameNode = node.childForFieldName('module_name')
      if (!moduleNameNode) return
      const modulePath = moduleNameNode
        ? moduleNameNode.type === 'relative_import'
          ? resolveImportedModulePath(
              moduleNameNode.text
                .replaceAll('..', '../')
                .replace(/^\.(?!\.)/g, './')
                .replace(/(\w+)\./g, '$1/'),
              file_path,
              '.py',
              '__init__.py',
            )
          : moduleNameNode.text
        : ''
      const imports = node.children.filter(
        (c) =>
          c &&
          (c.type === 'dotted_name' || c.type === 'aliased_import') &&
          !c.equals(moduleNameNode),
      )
      for (const imp of imports) {
        if (!imp) continue
        if (imp.type === 'dotted_name') {
          result.imports.push({
            id: randomUUIDv7(),
            file_path,
            module_path: modulePath,
            imported_name: imp.text,
          })
        } else if (imp.type === 'aliased_import') {
          const nameNode = imp.children.find((c) => c?.type === 'dotted_name')
          const aliasNode = imp.children.find((c) => c?.type === 'identifier')
          if (nameNode && aliasNode) {
            result.imports.push({
              id: randomUUIDv7(),
              file_path,
              module_path: modulePath,
              imported_name: aliasNode.text,
            })
          }
        }
      }
    }
  }

  /** Captures exception information during code analysis and links exceptions to their nearest symbol in the codebase by traversing parent nodes. */
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

  /** Captures environment variable references in a file by identifying their declaration context and adding metadata to the result. */
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

    const existing = result.envVars.find(
      (v) => v.symbol_id === symbol_id && v.file_path === file_path,
    )
    if (existing) return

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
    const callableKinds = [
      SymbolKind.function,
      SymbolKind.method,
      SymbolKind.class,
    ]

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
                s.id === symbol.parent_id &&
                callableKinds.includes(s.kind) &&
                !s.exported,
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
    let signature = ''
    for (let i = 0; i < lines.length; i++) {
      signature += lines[i] + '\n'
      if (lines[i]?.trim().endsWith(':')) {
        break
      }
    }
    return signature.trim()
  }
}
