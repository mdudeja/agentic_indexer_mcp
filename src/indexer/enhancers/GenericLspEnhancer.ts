import { readFileSync } from 'fs'
import { type Enhancer } from '../steps/s2_Enhancer.ts'
import { LspClient } from '../../utils/LspClient.ts'
import { logError, logInfo } from 'src/utils/logger.ts'
import { IndexerDB } from '../../database/IndexerDB.ts'
import * as schema from '../../database/schemas/index.ts'
import { SymbolKind } from '../../database/schemas/symbols.schema.ts'
import { InheritenceType } from '../../database/schemas/common.schema.ts'
import { eq, and, isNull, inArray, or } from 'drizzle-orm'
import { join, relative } from 'path'
import { AppStateManager } from 'src/state/index.ts'
import { allCallableKinds } from '../../utils/allCallableKinds.ts'
import { getParentsOfSymbolCall, parseTypeNames } from 'src/utils/misc.ts'

/** Enhancer implementation that connects to standard Language Servers (like typescript language server, Pyright, or gopls) for runtime type queries. */
export class GenericLspEnhancer implements Enhancer {
  private store: IndexerDB
  private db: ReturnType<IndexerDB['getDb']>
  private client: LspClient | null = null
  private openDocuments = new Set<string>()
  private initialized = false
  private available = false
  private serverCapabilities: Record<string, any> = {}

  /** Initializes a new instance of the GenericLspEnhancer class with the specified current working directory (cwd), LSP command, and language identifier. Sets up the database connection using IndexerDB. */
  constructor(
    private cwd: string,
    private lspCommand: string[],
    private languageId: string,
  ) {
    this.store = IndexerDB.getInstance()
    this.db = this.store.getDb()
  }

  /** Determines whether a specified capability is supported by the server. */
  private supports(capability: string): boolean {
    const cap = this.serverCapabilities[capability]
    return cap === true || (typeof cap === 'object' && cap !== null)
  }

  /** Initializes the LSP client and returns whether the initialization was successful. */
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

  /** Retrieves the type or documentation information at a specified location in a file based on Language Server Protocol (LSP) hover provider support. */
  async getTypeAtLocation(
    absPath: string,
    line: number,
    column: number,
    timeoutMs = 8000,
  ): Promise<string | null> {
    if (!this.available || !this.client || !this.supports('hoverProvider'))
      return null

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
      // logDebug(`[LSP Enhancer - ${this.languageId}] Hover request failed:`, err)
      return null
    }
  }

  /** Updates the file at the given absolute path and notifies external systems (like language servers) about the change. */
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
      // The file's content just changed, so any diagnostics the server
      // published for it are stale.
      this.client.invalidateDiagnostics(absPath)
    } catch (err) {
      logError(
        `[LSP Enhancer - ${this.languageId}] Failed to notify file changes:`,
        err,
      )
    }
  }

  /**
   * Opens every file in the batch (if not already open) and blocks until the
   * LSP server has finished analyzing all of them, so the subsequent
   * definition/reference/hover queries in this enhancement pass get
   * complete, settled answers. This replaces guessing with a fixed sleep and
   * running the whole enhancement step multiple times: without it, calls
   * resolved while the server is still warming up can lock in a wrong
   * answer (e.g. via the import-matching fallback) that a fully-warmed-up
   * definition lookup would have gotten right, and a later pass can never
   * revisit it since resolved calls are excluded from every subsequent query.
   */
  async prepareFiles(relPaths: string[]): Promise<void> {
    if (!this.available || !this.client) return

    const absPaths = relPaths.map((relPath) => join(this.cwd, relPath))
    for (const absPath of absPaths) {
      this.ensureFileOpen(absPath)
    }

    logInfo(
      `[LSP Enhancer - ${this.languageId}] Waiting for LSP to finish analyzing ${absPaths.length} files before enhancement...`,
    )
    await this.client.waitForDiagnostics(absPaths)
  }

  /** Closes the specified files by sending notifications to the language server and removing them from the list of open documents. */
  async closeFiles(relPaths: string[]): Promise<void> {
    if (!this.client) return
    for (const relPath of relPaths) {
      const absPath = join(this.cwd, relPath)
      if (!this.openDocuments.has(absPath)) continue
      this.client.notify('textDocument/didClose', {
        textDocument: {
          uri: `file://${absPath}`,
        },
      })
      this.openDocuments.delete(absPath)
    }
  }

  /** Enhances type information for callable symbols in specified files by adding parameter details and return types. */
  async enhanceSymbolTypesForCallables(relPaths: string[]): Promise<void> {
    if (!this.available || !this.client) {
      return
    }

    const { allCallableKinds } = await import('../../utils/allCallableKinds.ts')
    const callableKinds = await allCallableKinds()

    const symbols = await this.db
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

    let enhancedCount = 0

    for (const sym of symbols) {
      const signatureInfo = await this.getHoverSignatureForSymbol(sym)
      if (!signatureInfo) continue

      const { name: paramsStr, type: returnType } = signatureInfo

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

      await this.db
        .update(schema.symbols)
        .set({
          parameters_json: JSON.stringify(parameters),
          return_type: returnType || undefined,
        })
        .where(eq(schema.symbols.id, sym.id))
      enhancedCount++
    }
    logInfo(
      `[LSP Enhancer - ${this.languageId} - Callable Symbols Types] Total callable symbols: ${symbols.length}, enhanced with type info: ${enhancedCount}.`,
    )
  }

  /** Enhances interface inheritance by querying the LSP for implementation relationships and updating the database with these inherited interfaces. */
  async enhanceInterfaceInheritence(relPaths: string[]): Promise<void> {
    if (
      !this.available ||
      !this.client ||
      !this.supports('implementationProvider')
    ) {
      return
    }

    const interfaceSymbols = await this.db
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

    // Gather all "implements" hits from the LSP first
    type ImplementationHit = {
      implName: string
      implId: string
      filePath: string
      targetLine: number
    }
    const hits: ImplementationHit[] = []

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
          const filePath = relative(this.cwd, targetUri)
          const targetLine =
            loc.range?.start?.line ?? loc.targetSelectionRange?.start?.line
          if (targetLine === undefined) continue

          hits.push({
            implName: sym.name,
            implId: sym.id,
            filePath,
            targetLine,
          })
        }
      } catch (err) {
        logError(
          `[LSP Enhancer] Failed implementation request for ${sym.name}`,
          err,
        )
      }
    }

    let enhancedCount = 0
    if (hits.length > 0) {
      // Single batched lookup for every implementing symbol referenced by the hits.
      const locationKey = (filePath: string, line: number) =>
        `${filePath}#${line}`
      const uniqueLocations = new Map(
        hits.map((h) => [locationKey(h.filePath, h.targetLine), h]),
      )
      const implSymbols = await this.db
        .select({
          id: schema.symbols.id,
          file_path: schema.symbols.file_path,
          line: schema.symbols.line,
          inheritence: schema.symbols.inheritence,
        })
        .from(schema.symbols)
        .where(
          or(
            ...[...uniqueLocations.values()].map((h) =>
              and(
                eq(schema.symbols.file_path, h.filePath),
                eq(schema.symbols.line, h.targetLine),
              ),
            ),
          ),
        )
      const implSymbolsByLocation = new Map(
        implSymbols.map((s) => [locationKey(s.file_path, s.line), s]),
      )

      // Accumulate the new inheritance entries per implementing symbol, deduping
      // against both the existing DB state and the entries collected so far.
      const pendingUpdates = new Map<
        string,
        { existing: schema.Inheritence[]; toAdd: schema.Inheritence[] }
      >()

      for (const hit of hits) {
        const implSym = implSymbolsByLocation.get(
          locationKey(hit.filePath, hit.targetLine),
        )
        if (!implSym) continue

        let pending = pendingUpdates.get(implSym.id)
        if (!pending) {
          pending = { existing: implSym.inheritence ?? [], toAdd: [] }
          pendingUpdates.set(implSym.id, pending)
        }

        const alreadyHas =
          pending.existing.some(
            (i) =>
              i.inheritence_type === InheritenceType.implements &&
              i.inherits_from_name === hit.implName,
          ) || pending.toAdd.some((i) => i.inherits_from_name === hit.implName)
        if (alreadyHas) continue

        pending.toAdd.push({
          inheritence_type: InheritenceType.implements,
          inherits_from_name: hit.implName,
          inherits_from_id: hit.implId,
        })
      }

      for (const [implId, { existing, toAdd }] of pendingUpdates) {
        if (toAdd.length === 0) continue

        await this.db
          .update(schema.symbols)
          .set({ inheritence: [...existing, ...toAdd] })
          .where(eq(schema.symbols.id, implId))
        enhancedCount += toAdd.length
      }
    }

    logInfo(
      `[LSP Enhancer - ${this.languageId} - Interface Inheritance] Total interface symbols: ${interfaceSymbols.length}, implementation hits from LSP: ${hits.length}, enhanced inheritance entries: ${enhancedCount}.`,
    )
  }

  /** Enriches type symbols with inheritance information by analyzing their signatures and storing the relationships. This improves the language server's understanding of type hierarchies and dependencies. */
  async enhanceTypeInheritence(relPaths: string[]): Promise<void> {
    if (!this.available || !this.client) {
      return
    }

    const typeSymbols = await this.db
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
    const resolvedSymbols = await this.db
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

      await this.store.symbols.updateSymbolInheritance(id, inheritence)
      enhancedCount++
    }

    logInfo(
      `[LSP Enhancer - ${this.languageId} - Type Inheritance] Total type symbols: ${typeSymbols.length}, enhanced with inheritance info: ${enhancedCount}.`,
    )
  }

  /** Resolves all pending symbol calls for the specified relative file paths by attempting to resolve them through definitions, references, and imports, tracking resolution statistics. */
  async resolveAllPendingCalls(relPaths: string[]): Promise<void> {
    if (!this.available || !this.client) {
      return
    }

    const symbolCallResolutionStats = {
      definition: 0,
      references: 0,
      imports: 0,
    }

    const allPendingCallsCount = await this.db.$count(
      schema.symbol_calls,
      and(
        eq(schema.symbol_calls.language_name, this.languageId),
        eq(schema.symbol_calls.is_lang_feature, false),
        isNull(schema.symbol_calls.callee_id),
        isNull(schema.symbol_calls.imports_id),
        relPaths.length > 0
          ? inArray(schema.symbol_calls.caller_file_path, relPaths)
          : undefined,
      ),
    )

    const resolvedDefinitionCount =
      await this.resolvePendingCallViaDefinition(relPaths)
    symbolCallResolutionStats.definition += resolvedDefinitionCount

    const totalUnresolvedSymbolCallsCount = await this.db.$count(
      schema.symbol_calls,
      and(
        eq(schema.symbol_calls.language_name, this.languageId),
        eq(schema.symbol_calls.is_lang_feature, false),
        isNull(schema.symbol_calls.callee_id),
        isNull(schema.symbol_calls.imports_id),
        relPaths.length > 0
          ? inArray(schema.symbol_calls.caller_file_path, relPaths)
          : undefined,
      ),
    )

    const symbolIdToReferencesMap = new Map<
      string,
      Array<{
        name: string
        file_path: string
        line: number
        column: number
      }>
    >()

    const callableKinds = await allCallableKinds()
    const callableSymbols = await this.db
      .select()
      .from(schema.symbols)
      .where(
        and(
          eq(schema.symbols.language, this.languageId),
          inArray(schema.symbols.kind, callableKinds),
        ),
      )

    for (const sym of callableSymbols) {
      const references = await this.getReferencesForSymbol(
        sym.name,
        join(this.cwd, sym.file_path),
        sym.line,
        sym.column,
      )

      if (!references || references.length === 0) continue

      symbolIdToReferencesMap.set(sym.id, [
        ...(symbolIdToReferencesMap.get(sym.id) ?? []),
        ...references,
      ])
    }

    for (const [symbolId, references] of symbolIdToReferencesMap.entries()) {
      if (references.length === 0) continue

      await this.db
        .update(schema.symbol_calls)
        .set({ callee_id: symbolId })
        .where(
          and(
            eq(schema.symbol_calls.language_name, this.languageId),
            eq(schema.symbol_calls.is_lang_feature, false),
            isNull(schema.symbol_calls.callee_id),
            isNull(schema.symbol_calls.imports_id),
            or(
              ...references.map((ref) =>
                and(
                  eq(schema.symbol_calls.caller_file_path, ref.file_path),
                  eq(schema.symbol_calls.call_line, ref.line),
                  eq(schema.symbol_calls.call_column, ref.column),
                ),
              ),
            ),
          ),
        )
    }

    const remainingAfterReferences = await this.db.$count(
      schema.symbol_calls,
      and(
        eq(schema.symbol_calls.language_name, this.languageId),
        eq(schema.symbol_calls.is_lang_feature, false),
        isNull(schema.symbol_calls.callee_id),
        isNull(schema.symbol_calls.imports_id),
        relPaths.length > 0
          ? inArray(schema.symbol_calls.caller_file_path, relPaths)
          : undefined,
      ),
    )
    const resolvedCount =
      totalUnresolvedSymbolCallsCount - remainingAfterReferences

    symbolCallResolutionStats.references += resolvedCount

    const importsResolvedCount =
      await this.resolvePendingCallsViaImports(relPaths)
    symbolCallResolutionStats.imports += importsResolvedCount

    const totalResolved =
      symbolCallResolutionStats.definition +
      symbolCallResolutionStats.references +
      symbolCallResolutionStats.imports
    const remainingUnresolved = allPendingCallsCount - totalResolved

    logInfo(
      `[LSP Enhancer - ${this.languageId} - Symbol Calls] Resolved Counts. Definition: ${symbolCallResolutionStats.definition}, References: ${symbolCallResolutionStats.references}, Imports: ${symbolCallResolutionStats.imports}.`,
    )
    logInfo(
      `[LSP Enhancer - ${this.languageId} - Symbol Calls] Total Calls: ${allPendingCallsCount}, Resolved: ${totalResolved}, Remaining Unresolved: ${remainingUnresolved}`,
    )
  }

  /** Stops the background LSP process when disposing resources. */
  async dispose(): Promise<void> {
    if (this.client) {
      await this.client.stop()
    }
  }

  /** "Ensures the specified file is opened by notifying the language server if not already open." */
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

  /** Converts a hover string containing function or method information into a structured format with the function's name and return type. */
  private convertHoverStringToSignature(hoverStr: string):
    | {
        name?: string
        type?: string
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

    const match = cleanContent.match(/(.*?)(?:\s*)(?:->|=>|:)\s*([^\\\n|$]+)?/)

    if (!match) return

    const name = match[1]?.trim()
    const type = match[2]?.replace(/:$/, '')?.replace(/\s+/g, ' ').trim()

    return { name, type }
  }

  /** Hovers over a symbol's name (located via its signature) and parses the resulting hover string into a `{name, type}` pair. Returns `undefined` if hover info is unavailable. */
  private async getHoverSignatureForSymbol(sym: {
    file_path: string
    name: string
    line: number
    column: number
    signature?: string | null
  }): Promise<{ name?: string; type?: string } | undefined> {
    const absPath = join(this.cwd, sym.file_path)
    const nameOffset = sym.signature?.indexOf(sym.name) ?? 0
    const hoverStr = await this.getTypeAtLocation(
      absPath,
      sym.line,
      sym.column + nameOffset,
    )
    if (!hoverStr) return undefined

    return this.convertHoverStringToSignature(hoverStr)
  }

  /** This method retrieves all references for a given symbol at a specific location in a file. */
  private async getReferencesForSymbol(
    name: string,
    absPath: string,
    line: number,
    column: number,
  ): Promise<
    { name: string; file_path: string; line: number; column: number }[]
  > {
    if (
      !this.client ||
      !this.available ||
      !this.supports('referencesProvider')
    ) {
      return []
    }

    this.ensureFileOpen(absPath)

    try {
      const response = await this.client.request('textDocument/references', {
        textDocument: { uri: `file://${absPath}` },
        position: { line, character: column },
        context: { includeDeclaration: false },
      })

      if (!response || !Array.isArray(response)) return []

      return response.map((loc) => ({
        name,
        file_path: relative(this.cwd, loc.uri.replace('file://', '')),
        line: loc.range.start.line,
        column: loc.range.start.character,
      }))
    } catch (err) {
      logError(
        `[LSP Enhancer - ${this.languageId}] References request failed for ${absPath}:${line}:${column}`,
        err,
      )
      return []
    }
  }

  /** Retrieves the definition locations for a given symbol call by querying the language server. Returns an array of file paths with their corresponding line and column numbers where the symbol is defined. */
  private async getDefinitionForSymbolCall(
    call: schema.IndexedSymbolCall['Select'],
  ): Promise<{ file_path: string; line: number; column: number }[]> {
    if (
      !this.client ||
      !this.available ||
      !this.supports('definitionProvider')
    ) {
      return []
    }

    const absPath = join(this.cwd, call.caller_file_path)
    this.ensureFileOpen(absPath)

    try {
      const response = await this.client.request('textDocument/definition', {
        textDocument: { uri: `file://${absPath}` },
        position: { line: call.call_line, character: call.call_column },
      })

      if (!response) return []
      const locations = Array.isArray(response) ? response : [response]
      return locations.map((loc) => ({
        file_path: relative(this.cwd, loc.uri.replace('file://', '')),
        line: loc.range.start.line,
        column: loc.range.start.character,
      }))
    } catch (err) {
      logError(
        `[LSP Enhancer - ${this.languageId}] Definition request failed for ${absPath}:${call.call_line}:${call.call_column}`,
        err,
      )
      return []
    }
  }

  /** Groups an array of rows keyed by their `file_path`, preserving each row's original relative order within its group. */
  private groupByFilePath<T extends { file_path: string }>(
    rows: T[],
  ): Map<string, T[]> {
    const map = new Map<string, T[]>()
    for (const row of rows) {
      const arr = map.get(row.file_path) ?? []
      arr.push(row)
      map.set(row.file_path, arr)
    }
    return map
  }

  /** Batch-loads every import for the given files in a single query, grouped by file path. */
  private async loadImportsByFile(
    filePaths: string[],
  ): Promise<Map<string, schema.IndexedImport['Select'][]>> {
    if (filePaths.length === 0) return new Map()

    const rows = await this.db
      .select()
      .from(schema.imports)
      .where(inArray(schema.imports.file_path, filePaths))

    return this.groupByFilePath(rows)
  }

  /** Batch-loads every symbol for the given files in a single query, grouped by file path. */
  private async loadSymbolsByFile(
    filePaths: string[],
  ): Promise<Map<string, schema.IndexedSymbol['Select'][]>> {
    if (filePaths.length === 0) return new Map()

    const rows = await this.db
      .select()
      .from(schema.symbols)
      .where(inArray(schema.symbols.file_path, filePaths))

    return this.groupByFilePath(rows)
  }

  /** Finds the import whose name best matches a (possibly union) hover type string, searching only the imports already loaded for that file. Mirrors `LIKE '<name>%'` (case-insensitive prefix match). */
  private resolveImportIdByType(
    typeStr: string,
    importsForFile: schema.IndexedImport['Select'][] | undefined,
  ): string | undefined {
    if (!importsForFile || importsForFile.length === 0) return undefined

    const typeNames = parseTypeNames(typeStr.replaceAll('|', '').trim())
    // No usable type names were extracted: fall back to the first import in the
    // file, matching the original query's behavior when its LIKE clause list was empty.
    if (typeNames.length === 0) return importsForFile[0]?.id

    const match = importsForFile.find((imp) =>
      typeNames.some((name) =>
        imp.imported_name?.toLowerCase().startsWith(name.toLowerCase()),
      ),
    )
    return match?.id
  }

  /** Applies a batch of call -> import resolutions, issuing one UPDATE per distinct import (covering all of its calls via `inArray`) instead of one UPDATE per call. */
  private async applyImportResolutions(
    resolutions: { callId: string; importId: string }[],
  ): Promise<void> {
    if (resolutions.length === 0) return

    const callIdsByImport = new Map<string, string[]>()
    for (const { callId, importId } of resolutions) {
      const arr = callIdsByImport.get(importId) ?? []
      arr.push(callId)
      callIdsByImport.set(importId, arr)
    }

    for (const [importId, callIds] of callIdsByImport) {
      await this.db
        .update(schema.symbol_calls)
        .set({ imports_id: importId })
        .where(inArray(schema.symbol_calls.id, callIds))
    }
  }

  /** Resolves pending symbol calls by leveraging imported modules. This method attempts to match unresolved calls with their corresponding imports to fulfill language service requests. */
  private async resolvePendingCallsViaImports(
    relPaths: string[],
  ): Promise<number> {
    let totalResolvedCount = 0
    if (!this.available || !this.client) {
      return totalResolvedCount
    }

    const unresolvedCalls = await this.db
      .select()
      .from(schema.symbol_calls)
      .where(
        and(
          eq(schema.symbol_calls.language_name, this.languageId),
          eq(schema.symbol_calls.is_lang_feature, false),
          isNull(schema.symbol_calls.callee_id),
          isNull(schema.symbol_calls.imports_id),
          relPaths.length > 0
            ? inArray(schema.symbol_calls.caller_file_path, relPaths)
            : undefined,
        ),
      )

    // Preload imports/symbols for every file involved in one batched query each
    const distinctFiles = [
      ...new Set(unresolvedCalls.map((c) => c.caller_file_path)),
    ]
    const importsByFile = await this.loadImportsByFile(distinctFiles)
    const symbolsByFile = await this.loadSymbolsByFile(distinctFiles)

    let resolvedCount = 0
    const stillUnresolvedCalls = new Set<schema.IndexedSymbolCall['Select']>()
    const passAResolutions: { callId: string; importId: string }[] = []

    for (const call of unresolvedCalls) {
      const parents = getParentsOfSymbolCall(call.call_text, call.callee_name)
      const namesToMatch = new Set([...parents, call.callee_name])
      const importEntry = (importsByFile.get(call.caller_file_path) ?? []).find(
        (imp) =>
          imp.imported_name !== null && namesToMatch.has(imp.imported_name),
      )

      if (!importEntry) {
        stillUnresolvedCalls.add(call)
        continue
      }

      passAResolutions.push({ callId: call.id, importId: importEntry.id })
      resolvedCount++
    }
    await this.applyImportResolutions(passAResolutions)

    totalResolvedCount += resolvedCount

    resolvedCount = 0
    const passBResolutions: { callId: string; importId: string }[] = []

    for (const call of stillUnresolvedCalls) {
      const parents = getParentsOfSymbolCall(
        call.call_text,
        call.callee_name,
      ).reverse()

      const candidateSymbol = (
        symbolsByFile.get(call.caller_file_path) ?? []
      ).find((s) => parents.includes(s.name))

      if (!candidateSymbol) {
        const importId = await this.findImportIdViaParentType(
          call,
          parents,
          importsByFile,
        )
        if (importId) {
          passBResolutions.push({ callId: call.id, importId })
          resolvedCount++
        }
        continue
      }

      const signatureInfo =
        await this.getHoverSignatureForSymbol(candidateSymbol)
      if (!signatureInfo || !signatureInfo.type) continue

      const importId = this.resolveImportIdByType(
        signatureInfo.type,
        importsByFile.get(call.caller_file_path),
      )
      if (!importId) continue

      passBResolutions.push({ callId: call.id, importId })
      resolvedCount++
    }
    await this.applyImportResolutions(passBResolutions)

    totalResolvedCount += resolvedCount
    return totalResolvedCount
  }

  /** This method resolves pending symbol calls by checking their definitions against known language feature paths. It updates unresolved calls in the database and returns the number of successfully resolved items. */
  private async resolvePendingCallViaDefinition(
    relPaths: string[],
  ): Promise<number> {
    const langFeaturePaths: string[] =
      AppStateManager.getInstance().getItem('config')?.languages?.[
        this.languageId
      ]?.lang_features_paths ?? []
    const unresolvedCalls = await this.db
      .select()
      .from(schema.symbol_calls)
      .where(
        and(
          eq(schema.symbol_calls.language_name, this.languageId),
          eq(schema.symbol_calls.is_lang_feature, false),
          isNull(schema.symbol_calls.callee_id),
          isNull(schema.symbol_calls.imports_id),
          relPaths.length > 0
            ? inArray(schema.symbol_calls.caller_file_path, relPaths)
            : undefined,
        ),
      )

    let resolvedCount = 0
    const langFeatureCalls = new Set<string>()

    for (const call of unresolvedCalls) {
      const definitions = await this.getDefinitionForSymbolCall(call)
      if (definitions.length === 0) continue

      const isEs5 = definitions.every((def) =>
        langFeaturePaths.some((featPath) => def.file_path.includes(featPath)),
      )

      if (isEs5) {
        langFeatureCalls.add(call.id)
        resolvedCount++
      }
    }

    if (langFeatureCalls.size == 0) {
      return 0
    }

    await this.db
      .update(schema.symbol_calls)
      .set({ is_lang_feature: true })
      .where(inArray(schema.symbol_calls.id, [...langFeatureCalls]))

    return resolvedCount
  }

  /** Hovers at the call site itself (rather than at a parent symbol's declaration) to recover a return type, then resolves it to an import id using the preloaded imports for that file. Returns `undefined` instead of writing directly, so callers can batch the resulting writes. */
  private async findImportIdViaParentType(
    call: schema.IndexedSymbolCall['Select'],
    parents: string[],
    importsByFile: Map<string, schema.IndexedImport['Select'][]>,
  ): Promise<string | undefined> {
    if (parents.length === 0 || !call.call_line || !call.call_column) {
      return undefined
    }

    const absPath = join(this.cwd, call.caller_file_path)
    const hoverStr = await this.getTypeAtLocation(
      absPath,
      call.call_line,
      call.call_column + call.call_text.indexOf(call.callee_name) - 2,
    )
    if (!hoverStr) return undefined

    const signatureInfo = this.convertHoverStringToSignature(hoverStr)
    if (!signatureInfo || !signatureInfo.type) return undefined

    return this.resolveImportIdByType(
      signatureInfo.type,
      importsByFile.get(call.caller_file_path),
    )
  }
}
