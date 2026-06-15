import { readFileSync } from 'fs'
import { type Enhancer } from '../steps/s2_Enhancer.ts'
import { LspClient } from '../../utils/LspClient.ts'
import { logError, logInfo } from 'src/utils/logger.ts'
import { IndexerDB } from '../../database/IndexerDB.ts'
import * as schema from '../../database/schemas/index.ts'
import { SymbolKind } from '../../database/schemas/symbols.schema.ts'
import { InheritenceType } from '../../database/schemas/common.schema.ts'
import { eq, and, isNull, inArray, like } from 'drizzle-orm'
import { join, relative } from 'path'
import {
  getParentsOfSymbolCall,
  getTypeNameWithoutParent,
  parseTypeNames,
} from 'src/utils/misc.ts'
import { AppStateManager } from 'src/state/index.ts'

/** Enhancer implementation that connects to standard Language Servers (like Pyright or gopls) for runtime type queries. */
export class GenericLspEnhancer implements Enhancer {
  private client: LspClient | null = null
  private openDocuments = new Set<string>()
  private initialized = false
  private available = false
  private serverCapabilities: Record<string, any> = {}

  constructor(
    private cwd: string,
    private lspCommand: string[],
    private languageId: string,
  ) {}

  private supports(capability: string): boolean {
    const cap = this.serverCapabilities[capability]
    return cap === true || (typeof cap === 'object' && cap !== null)
  }

  async init(): Promise<boolean> {
    if (this.initialized) return this.available
    this.initialized = true

    try {
      this.client = new LspClient(this.lspCommand, this.cwd)
      await this.client.start()
      this.serverCapabilities = this.client.capabilities
      this.available = true
    } catch (err) {
      logError(
        `[LSP Enhancer - ${this.languageId}] Failed to initialize LSP client:`,
        err,
      )
      this.available = false
    }

    return this.available
  }

  private ensureFileOpen(absPath: string): void {
    if (!this.client || this.openDocuments.has(absPath)) return

    try {
      const text = readFileSync(absPath, 'utf8')
      this.client.notify('textDocument/didOpen', {
        textDocument: {
          uri: `file://${absPath}`,
          languageId: this.languageId,
          version: 1,
          text,
        },
      })
      this.openDocuments.add(absPath)
    } catch (err) {
      logError(
        `[LSP Enhancer - ${this.languageId}] Failed to open document:`,
        err,
      )
    }
  }

  async getTypeAtLocation(
    absPath: string,
    line: number,
    column: number,
    timeoutMs = 8000,
  ): Promise<string | null> {
    if (!this.available || !this.client) return null

    this.ensureFileOpen(absPath)

    try {
      const response = await this.client.request(
        'textDocument/hover',
        {
          textDocument: {
            uri: `file://${absPath}`,
          },
          position: {
            line,
            character: column,
          },
        },
        timeoutMs,
      )

      if (!response || !response.contents) return null

      const contents = response.contents

      // Extract markdown/plaintext content from different hover payload structures
      if (typeof contents === 'string') {
        return contents
      }
      if (Array.isArray(contents)) {
        return contents
          .map((c) => (typeof c === 'string' ? c : c.value))
          .join('\n')
      }
      if (contents.value) {
        return contents.value
      }
      return null
    } catch (err) {
      logError(`[LSP Enhancer - ${this.languageId}] Hover request failed:`, err)
      return null
    }
  }

  convertHoverStringToSignature(hoverStr: string):
    | {
        paramsStr?: string
        returnType?: string
      }
    | undefined {
    const allLanguages = Object.keys(
      AppStateManager.getInstance().getItem('config')?.languages ?? {},
    )
    const languageRegexString = allLanguages.join('|')
    // Extract markdown code blocks to avoid noise from description
    const codeBlocks = hoverStr.match(/```[a-z]*\n([\s\S]*?)```/g)
    const contentToParse = codeBlocks
      ? codeBlocks
          .map((b) =>
            b.replace(new RegExp(`\`\`\`(${languageRegexString})\n`, 'g'), ''),
          )
          .map((b) => b.replace(/```/g, ''))
          .join('\n')
      : hoverStr

    // Strip LSP prefixes like "(method)", "(alias)", "(function)"
    const cleanContent = contentToParse.replace(/^\([a-z]+\)\s*/i, '')
    const isCall = cleanContent.includes('(') && cleanContent.includes(')')
    const isImport =
      cleanContent.toLowerCase().startsWith('import ') ||
      cleanContent.includes(' from ') ||
      cleanContent.includes(' require(')

    const match = isImport
      ? cleanContent
          .replace(new RegExp(/import|require|from/), '')
          .match(/([\w.]+)(?:\s+as\s+[\w.]+)?/)
      : isCall
        ? cleanContent.match(/\((.*?)\)(?:\s*(?:->|=>|:)\s*([^\n]*))?/)
        : cleanContent.match(/(.*?)(?:\s*)(?:->|=>|:)\s*([^\n]*)?/)

    if (!match) return

    const paramsStr = match[1]?.trim()
    const returnType = isImport
      ? match[1]?.trim()
      : isCall
        ? match[2]?.replace(/:$/, '')?.replace(/\s+/g, ' ').trim()
        : parseTypeNames(
            match[2]
              ?.replace(/:$/, '')
              ?.replace(/\s+/g, ' ')
              .replace(/\|\s*\S+$/g, '')
              ?.trim() ?? '',
          )[0]

    return { paramsStr, returnType }
  }

  refreshFile(absPath: string): void {
    if (!this.client || !this.openDocuments.has(absPath)) return

    try {
      const text = readFileSync(absPath, 'utf8')
      this.client.notify('textDocument/didChange', {
        textDocument: {
          uri: `file://${absPath}`,
          version: Date.now(),
        },
        contentChanges: [{ text }],
      })
    } catch (err) {
      logError(
        `[LSP Enhancer - ${this.languageId}] Failed to notify file changes:`,
        err,
      )
    }
  }

  async enhanceSymbolTypesForCallables(relPaths: string[]): Promise<void> {
    if (!this.available || !this.client || !this.supports('hoverProvider')) {
      return
    }
    logInfo(
      `[LSP Enhancer - ${this.languageId}] Enhancing symbol types for callables in ${relPaths.length} files...`,
    )

    const { allCallableKinds } = await import('../../utils/allCallableKinds.ts')
    const callableKinds = await allCallableKinds()
    const db = IndexerDB.getInstance().getDb()

    const symbols = await db
      .select({
        id: schema.symbols.id,
        name: schema.symbols.name,
        file_path: schema.symbols.file_path,
        line: schema.symbols.line,
        column: schema.symbols.column,
        signature: schema.symbols.signature,
      })
      .from(schema.symbols)
      .where(
        and(
          eq(schema.symbols.language, this.languageId),
          inArray(schema.symbols.kind, callableKinds),
          isNull(schema.symbols.parameters_json),
          relPaths.length > 0
            ? inArray(schema.symbols.file_path, relPaths)
            : undefined,
        ),
      )

    logInfo(
      `[LSP Enhancer - ${this.languageId}] Found ${symbols.length} callable symbols to enhance.`,
    )
    let enhancedCount = 0

    for (const sym of symbols) {
      const absPath = join(this.cwd, sym.file_path)
      const hoverStr = await this.getTypeAtLocation(
        absPath,
        sym.line,
        sym.column + (sym.signature?.indexOf(sym.name) ?? 0),
      )
      if (!hoverStr) continue

      const signatureInfo = this.convertHoverStringToSignature(hoverStr)
      if (!signatureInfo) continue

      const { paramsStr, returnType } = signatureInfo

      let parameters: { name: string; type: string }[] = []
      if (paramsStr && paramsStr.trim().length > 0) {
        const paramParts = paramsStr.split(',').map((p) => p.trim())
        parameters = paramParts.map((p) => {
          const [name, ...typeParts] = p.split(':')
          return {
            name: name?.trim() ?? '',
            type: typeParts.join(':').trim() || 'any',
          }
        })
      }

      await db
        .update(schema.symbols)
        .set({
          parameters_json: JSON.stringify(parameters),
          return_type: returnType || undefined,
        })
        .where(eq(schema.symbols.id, sym.id))
      enhancedCount++
    }
    logInfo(
      `[LSP Enhancer - ${this.languageId}] Enhanced ${enhancedCount} out of ${symbols.length} callable symbols.`,
    )
  }

  async enhanceInterfaceInheritence(relPaths: string[]): Promise<void> {
    if (
      !this.available ||
      !this.client ||
      !this.supports('implementationProvider')
    ) {
      return
    }
    logInfo(
      `[LSP Enhancer - ${this.languageId}] Enhancing symbol types for inherited types and interfaces in ${relPaths.length} files...`,
    )

    const db = IndexerDB.getInstance().getDb()

    const interfaceSymbols = await db
      .select({
        id: schema.symbols.id,
        name: schema.symbols.name,
        file_path: schema.symbols.file_path,
        line: schema.symbols.line,
        column: schema.symbols.column,
      })
      .from(schema.symbols)
      .where(
        and(
          eq(schema.symbols.language, this.languageId),
          eq(schema.symbols.kind, SymbolKind.interface),
          relPaths.length > 0
            ? inArray(schema.symbols.file_path, relPaths)
            : undefined,
        ),
      )

    logInfo(
      `[LSP Enhancer - ${this.languageId}] Found ${interfaceSymbols.length} interface symbols to enhance.`,
    )
    let enhancedCount = 0

    for (const sym of interfaceSymbols) {
      const absPath = join(this.cwd, sym.file_path)
      this.ensureFileOpen(absPath)
      try {
        const response = await this.client.request(
          'textDocument/implementation',
          {
            textDocument: { uri: `file://${absPath}` },
            position: { line: sym.line, character: sym.column },
          },
        )
        if (!response) continue

        const locations = Array.isArray(response) ? response : [response]
        for (const loc of locations) {
          if (!loc?.uri) continue
          const targetUri = loc.uri.replace('file://', '')
          const relPath = relative(this.cwd, targetUri)
          const targetLine =
            loc.range?.start?.line ?? loc.targetSelectionRange?.start?.line
          if (targetLine === undefined) continue

          const implSymbols = await db
            .select({
              id: schema.symbols.id,
              inheritence: schema.symbols.inheritence,
            })
            .from(schema.symbols)
            .where(
              and(
                eq(schema.symbols.file_path, relPath),
                eq(schema.symbols.line, targetLine),
              ),
            )
            .limit(1)

          if (implSymbols.length === 0) continue

          const implSym = implSymbols[0]!
          const existingInherits =
            implSym.inheritence?.filter(
              (i) =>
                i.inheritence_type === InheritenceType.implements &&
                i.inherits_from_name === sym.name,
            ) ?? []
          if (existingInherits.length > 0) continue

          await db
            .update(schema.symbols)
            .set({
              inheritence: [
                ...(implSym.inheritence ?? []),
                {
                  inheritence_type: InheritenceType.implements,
                  inherits_from_name: sym.name,
                  inherits_from_id: sym.id,
                },
              ],
            })
            .where(eq(schema.symbols.id, implSym.id))

          enhancedCount++
        }
      } catch (err) {
        logError(
          `[LSP Enhancer] Failed implementation request for ${sym.name}`,
          err,
        )
      }
    }

    logInfo(
      `[LSP Enhancer - ${this.languageId}] Enhanced ${enhancedCount} for ${interfaceSymbols.length} interface symbols with inheritance info.`,
    )
  }

  async enhanceTypeInheritence(relPaths: string[]): Promise<void> {
    if (!this.available || !this.client) {
      return
    }
    logInfo(
      `[LSP Enhancer - ${this.languageId}] Enhancing type inheritance for ${relPaths.length} files...`,
    )

    const store = IndexerDB.getInstance()
    const db = store.getDb()

    const typeSymbols = await db
      .select({
        id: schema.symbols.id,
        name: schema.symbols.name,
        kind: schema.symbols.kind,
        file_path: schema.symbols.file_path,
        line: schema.symbols.line,
        column: schema.symbols.column,
        signature: schema.symbols.signature,
      })
      .from(schema.symbols)
      .where(
        and(
          eq(schema.symbols.language, this.languageId),
          inArray(schema.symbols.kind, [
            SymbolKind.class,
            SymbolKind.interface,
            SymbolKind.type,
          ]),
          relPaths.length > 0
            ? inArray(schema.symbols.file_path, relPaths)
            : undefined,
        ),
      )

    logInfo(
      `[LSP Enhancer - ${this.languageId}] Found ${typeSymbols.length} type symbols to check for inheritance.`,
    )

    // Collect all candidate parent names up front for a single batch DB lookup
    type Candidate = {
      id: string
      inheritence: schema.Inheritence[]
    }
    const candidates: Candidate[] = []
    const allParentNames = new Set<string>()

    for (const sym of typeSymbols) {
      if (!sym.signature) continue

      const inheritence: schema.Inheritence[] = []

      if (sym.kind === SymbolKind.class || sym.kind === SymbolKind.interface) {
        // `class Foo<T> extends Bar<T> implements IFoo, IBar`
        // `interface IFoo extends IBar, IBaz`
        const extendsMatch = sym.signature.match(
          /\bextends\s+([\w<>[\], .]+?)(?=\s+implements\b|\s*\{|\s*$)/,
        )
        const implementsMatch = sym.signature.match(
          /\bimplements\s+([\w<>[\], .]+?)(?=\s*\{|\s*$)/,
        )

        if (extendsMatch) {
          inheritence.push(
            ...parseTypeNames(extendsMatch[1]!).map((n) => ({
              inheritence_type: InheritenceType.extends,
              inherits_from_name: n,
              inherits_from_id: '',
            })),
          )
        }
        if (implementsMatch) {
          inheritence.push(
            ...parseTypeNames(implementsMatch[1]!).map((n) => ({
              inheritence_type: InheritenceType.implements,
              inherits_from_name: n,
              inherits_from_id: '',
            })),
          )
        }
      }

      if (sym.kind === SymbolKind.type) {
        // `type Foo = <RHS>`
        const rhsMatch = sym.signature.match(/=\s*([\s\S]+)$/)
        if (!rhsMatch) continue
        const rhs = rhsMatch[1]!.trim()

        if (rhs.includes('&')) {
          inheritence.push(
            ...parseTypeNames(rhs.replace(/&/g, ',')).map((n) => ({
              inheritence_type: InheritenceType.intersection,
              inherits_from_name: n,
              inherits_from_id: '',
            })),
          )
        } else if (rhs.includes('|')) {
          inheritence.push(
            ...parseTypeNames(rhs.replace(/\|/g, ',')).map((n) => ({
              inheritence_type: InheritenceType.union,
              inherits_from_name: n,
              inherits_from_id: '',
            })),
          )
        } else {
          // Utility types: Pick<Base, ...>, Omit<Base, ...>, etc.
          const utilityMatch = rhs.match(/^[\w.]+\s*<\s*([\w.]+)/)
          if (utilityMatch) {
            inheritence.push({
              inheritence_type: InheritenceType.extends,
              inherits_from_name: utilityMatch[1]!,
              inherits_from_id: '',
            })
          }
        }
      }

      if (inheritence.length === 0) continue

      candidates.push({ id: sym.id, inheritence: inheritence })
      inheritence.forEach((i) => {
        allParentNames.add(i.inherits_from_name)
      })
    }

    if (candidates.length === 0) {
      logInfo(
        `[LSP Enhancer - ${this.languageId}] No inheritance relationships found.`,
      )
      return
    }

    // Single batch lookup: which candidate names actually exist as symbols?
    const resolvedSymbols = await db
      .select({ name: schema.symbols.name, id: schema.symbols.id })
      .from(schema.symbols)
      .where(inArray(schema.symbols.name, [...allParentNames]))
    const resolvedNames = new Set(resolvedSymbols.map((s) => s.name))

    let enhancedCount = 0
    for (const { id, inheritence } of candidates) {
      const resolved = inheritence
        .map((i) => i.inherits_from_name)
        .filter((n) => resolvedNames.has(n))
      if (resolved.length === 0) continue

      await store.symbols.updateSymbolInheritance(id, inheritence)
      enhancedCount++
    }

    logInfo(
      `[LSP Enhancer - ${this.languageId}] Enhanced ${enhancedCount} out of ${typeSymbols.length} type symbols with inheritance info.`,
    )
  }

  private async resolveCallViaDb(
    db: ReturnType<IndexerDB['getDb']>,
    callerFilePath: string,
    calleeName: string,
    callId: string,
    call_text: string,
  ): Promise<boolean> {
    const symbolCallParents = getParentsOfSymbolCall(call_text, calleeName)
    const importRecords = await db
      .select({
        id: schema.imports.id,
        module_path: schema.imports.module_path,
      })
      .from(schema.imports)
      .where(
        and(
          eq(schema.imports.file_path, callerFilePath),
          inArray(schema.imports.imported_name, [
            ...symbolCallParents,
            calleeName,
          ]),
        ),
      )
      .limit(1)

    if (importRecords.length > 0) {
      const { id: importId, module_path } = importRecords[0]!
      const targetSymbols = await db
        .select({ id: schema.symbols.id })
        .from(schema.symbols)
        .where(
          and(
            like(schema.symbols.file_path, module_path + '%'),
            eq(schema.symbols.name, calleeName),
            eq(schema.symbols.language, this.languageId),
          ),
        )
        .limit(1)

      if (targetSymbols.length > 0) {
        await db
          .update(schema.symbol_calls)
          .set({ callee_id: targetSymbols[0]!.id })
          .where(eq(schema.symbol_calls.id, callId))
        return true
      }

      await db
        .update(schema.symbol_calls)
        .set({ imports_id: importId })
        .where(eq(schema.symbol_calls.id, callId))
      return true
    }

    return false
  }

  async resolveAllPendingCalls(relPaths: string[]): Promise<void> {
    if (!this.available || !this.client) {
      return
    }

    logInfo(
      `[LSP Enhancer] Resolving pending calls for ${relPaths.length} files. This may take a while...`,
    )

    const db = IndexerDB.getInstance().getDb()

    const calls = await db
      .select()
      .from(schema.symbol_calls)
      .where(
        and(
          isNull(schema.symbol_calls.callee_id),
          isNull(schema.symbol_calls.imports_id),
          eq(schema.symbol_calls.language_name, this.languageId),
          relPaths.length > 0
            ? inArray(schema.symbol_calls.caller_file_path, relPaths)
            : undefined,
        ),
      )

    logInfo(`[LSP Enhancer] Found ${calls.length} calls to resolve.`)
    let resolvedCount = 0

    // Pass 1: resolve via imports table + direct name match (no LSP needed).
    const unresolved: typeof calls = []
    for (const call of calls) {
      const resolved = await this.resolveCallViaDb(
        db,
        call.caller_file_path,
        call.callee_name,
        call.id,
        call.call_text,
      )
      if (resolved) {
        resolvedCount++
      } else {
        unresolved.push(call)
      }
    }

    logInfo(
      `[LSP Enhancer] Pass 1 resolved ${resolvedCount}/${calls.length} calls. ${unresolved.length} remain for LSP.`,
    )

    // Pass 2: LSP fallback for calls that couldn't be resolved via the DB.
    for (const call of unresolved) {
      if (call.call_line == null || call.call_column == null) continue

      const resolved = await this.updateCalleeInfoViaDefinition(call)
      if (resolved) {
        unresolved.splice(unresolved.indexOf(call), 1)
        resolvedCount++
      }
    }

    // Pass 3: LSP fallback for calls that couldn't be resolved via the DB or definition, using hover info.
    const updatedResolvedCount = await this.updateCalleeInfoViaHover(
      unresolved,
      resolvedCount,
    )

    if (updatedResolvedCount !== undefined) {
      resolvedCount = updatedResolvedCount
    }

    logInfo(
      `[LSP Enhancer] Resolved ${resolvedCount} out of ${calls.length} total calls.`,
    )
  }

  private async updateCalleeInfoViaDefinition(
    call: schema.IndexedSymbolCall['Select'],
  ): Promise<boolean> {
    if (
      !this.available ||
      !this.client ||
      !this.supports('definitionProvider')
    ) {
      return false
    }

    const db = IndexerDB.getInstance().getDb()
    const absPath = join(this.cwd, call.caller_file_path)
    this.ensureFileOpen(absPath)

    try {
      const response = await this.client.request('textDocument/definition', {
        textDocument: { uri: `file://${absPath}` },
        position: { line: call.call_line, character: call.call_column },
      })
      if (!response) return false

      const targetLocation =
        Array.isArray(response) && response.length > 0 ? response[0] : response

      if (!targetLocation?.uri) return false

      const targetAbsPath = targetLocation.uri.replace('file://', '')

      const relPath = relative(this.cwd, targetAbsPath)
      const targetLine =
        targetLocation.targetSelectionRange?.start?.line ??
        targetLocation.range?.start?.line

      if (targetLine === undefined) return false

      const targetSymbols = await db
        .select({ id: schema.symbols.id })
        .from(schema.symbols)
        .where(
          and(
            eq(schema.symbols.file_path, relPath),
            eq(schema.symbols.line, targetLine),
          ),
        )
        .limit(1)

      if (targetSymbols.length === 0) return false

      await db
        .update(schema.symbol_calls)
        .set({ callee_id: targetSymbols[0]!.id })
        .where(eq(schema.symbol_calls.id, call.id))
      return true
    } catch (err) {
      logError(
        `[LSP Enhancer] Failed definition request for call ${call.id}`,
        err,
      )
      return false
    }
  }

  private async updateCalleeInfoViaHover(
    calls: Array<schema.IndexedSymbolCall['Select']>,
    resolvedCount: number,
  ): Promise<number | void> {
    if (!this.available || !this.client || !this.supports('hoverProvider')) {
      return
    }

    const db = IndexerDB.getInstance().getDb()

    const typeNamesToResolve: Map<
      string,
      Array<schema.IndexedSymbolCall['Select']>
    > = new Map()

    for (const call of calls) {
      if (call.call_line == null || call.call_column == null) continue

      const absPath = join(this.cwd, call.caller_file_path)
      const hoverStr = await this.getTypeAtLocation(
        absPath,
        call.call_line,
        call.call_column - 2, // adjust column to point to the parent
      )
      if (!hoverStr) continue

      const signatureInfo = this.convertHoverStringToSignature(hoverStr)
      if (!signatureInfo || !signatureInfo.returnType) continue

      const returnType = getTypeNameWithoutParent(signatureInfo.returnType)
      if (!typeNamesToResolve.has(returnType)) {
        typeNamesToResolve.set(returnType, [])
      }
      typeNamesToResolve.get(returnType)!.push(call)
    }

    if (!typeNamesToResolve.size) return

    for (const [typeName, calls] of typeNamesToResolve.entries()) {
      for (const call of calls) {
        const resolved = await this.resolveCallViaDb(
          db,
          call.caller_file_path,
          typeName,
          call.id,
          call.call_text,
        )
        if (resolved) {
          resolvedCount++
        }
      }
    }
    return resolvedCount
  }

  /** Stops the background LSP process when disposing resources. */
  async dispose(): Promise<void> {
    if (this.client) {
      await this.client.stop()
    }
  }
}
