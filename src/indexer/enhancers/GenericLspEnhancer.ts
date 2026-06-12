import { readFileSync } from 'fs'
import { type Enhancer } from '../steps/s2_Enhancer.ts'
import { LspClient } from '../../utils/LspClient.ts'
import { logError, logInfo } from 'src/utils/logger.ts'
import { IndexerDB } from '../../database/IndexerDB.ts'
import * as schema from '../../database/schemas/index.ts'
import { SymbolKind } from '../../database/schemas/symbols.schema.ts'
import { InheritenceType } from '../../database/schemas/common.schema.ts'
import { eq, and, isNull, inArray } from 'drizzle-orm'
import { join, relative } from 'path'
import { parseTypeNames } from 'src/utils/misc.ts'

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
  ): Promise<string | null> {
    if (!this.available || !this.client) return null

    this.ensureFileOpen(absPath)

    try {
      const response = await this.client.request('textDocument/hover', {
        textDocument: {
          uri: `file://${absPath}`,
        },
        position: {
          line,
          character: column,
        },
      })

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
        sym.column,
      )
      if (!hoverStr) continue

      // Extract markdown code blocks to avoid noise from description
      const codeBlocks = hoverStr.match(/```[a-z]*\n([\s\S]*?)```/g)
      const contentToParse = codeBlocks
        ? codeBlocks.map((b) => b.replace(/```[a-z]*\n|```/g, '')).join('\n')
        : hoverStr

      // Strip LSP prefixes like "(method)", "(alias)", "(function)"
      const cleanContent = contentToParse.replace(/^\([a-z]+\)\s*/i, '')

      const match = cleanContent.match(
        /\((.*?)\)(?:\s*(?:->|=>|:)\s*([\s\S]*))?/,
      )

      if (!match) continue

      const paramsStr = match[1]
      const returnType = match[2]
        ?.replace(/:$/, '')
        ?.replace(/\s+/g, ' ')
        .trim()

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
              inherits_from_names: schema.symbols.inherits_from_names,
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
          const existingInherits = implSym.inherits_from_names
            ? implSym.inherits_from_names.split(',').map((s) => s.trim())
            : []
          if (existingInherits.includes(sym.name)) continue

          await db
            .update(schema.symbols)
            .set({
              inherits_from_names: [...existingInherits, sym.name].join(', '),
              inheritence_type: InheritenceType.implements,
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

    const db = IndexerDB.getInstance().getDb()

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
      parentNames: string[]
      inheritenceType: InheritenceType
    }
    const candidates: Candidate[] = []
    const allCandidateNames = new Set<string>()

    for (const sym of typeSymbols) {
      if (!sym.signature) continue

      let parentNames: string[] = []
      let inheritenceType: InheritenceType | null = null

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
          parentNames.push(...parseTypeNames(extendsMatch[1]!))
          inheritenceType = InheritenceType.extends
        }
        if (implementsMatch) {
          parentNames.push(...parseTypeNames(implementsMatch[1]!))
          if (!inheritenceType) inheritenceType = InheritenceType.implements
        }
      }

      if (sym.kind === SymbolKind.type) {
        // `type Foo = <RHS>`
        const rhsMatch = sym.signature.match(/=\s*([\s\S]+)$/)
        if (!rhsMatch) continue
        const rhs = rhsMatch[1]!.trim()

        if (rhs.includes('&')) {
          parentNames = parseTypeNames(rhs.replace(/&/g, ','))
          inheritenceType = InheritenceType.intersection
        } else if (rhs.includes('|')) {
          parentNames = parseTypeNames(rhs.replace(/\|/g, ','))
          inheritenceType = InheritenceType.union
        } else {
          // Utility types: Pick<Base, ...>, Omit<Base, ...>, etc.
          const utilityMatch = rhs.match(/^[\w.]+\s*<\s*([\w.]+)/)
          if (utilityMatch) {
            parentNames = [utilityMatch[1]!]
            inheritenceType = InheritenceType.extends
          }
        }
      }

      if (parentNames.length === 0 || !inheritenceType) continue

      candidates.push({ id: sym.id, parentNames, inheritenceType })
      parentNames.forEach((n) => allCandidateNames.add(n))
    }

    if (candidates.length === 0) {
      logInfo(
        `[LSP Enhancer - ${this.languageId}] No inheritance relationships found.`,
      )
      return
    }

    // Single batch lookup: which candidate names actually exist as symbols?
    const resolvedSymbols = await db
      .select({ name: schema.symbols.name })
      .from(schema.symbols)
      .where(inArray(schema.symbols.name, [...allCandidateNames]))
    const resolvedNames = new Set(resolvedSymbols.map((s) => s.name))

    let enhancedCount = 0
    for (const { id, parentNames, inheritenceType } of candidates) {
      const resolved = parentNames.filter((n) => resolvedNames.has(n))
      if (resolved.length === 0) continue

      await db
        .update(schema.symbols)
        .set({
          inherits_from_names: resolved.join(', '),
          inheritence_type: inheritenceType,
        })
        .where(eq(schema.symbols.id, id))
      enhancedCount++
    }

    logInfo(
      `[LSP Enhancer - ${this.languageId}] Enhanced ${enhancedCount} out of ${typeSymbols.length} type symbols with inheritance info.`,
    )
  }

  async resolveAllPendingCalls(relPaths: string[]): Promise<void> {
    if (
      !this.available ||
      !this.client ||
      !this.supports('definitionProvider')
    ) {
      return
    }

    logInfo(
      `[LSP Enhancer] Resolving pending calls for ${relPaths.length} files. This may take a while...`,
    )

    const db = IndexerDB.getInstance().getDb()

    const calls = await db
      .select({
        call_id: schema.symbol_calls.id,
        file_path: schema.symbols.file_path,
        line: schema.symbol_calls.call_line,
        column: schema.symbol_calls.call_column,
      })
      .from(schema.symbol_calls)
      .innerJoin(
        schema.symbols,
        eq(schema.symbol_calls.caller_id, schema.symbols.id),
      )
      .where(
        and(
          isNull(schema.symbol_calls.callee_id),
          eq(schema.symbols.language, this.languageId),
          relPaths.length > 0
            ? inArray(schema.symbols.file_path, relPaths)
            : undefined,
        ),
      )

    logInfo(`[LSP Enhancer] Found ${calls.length} calls to resolve.`)
    let resolvedCount = 0

    for (const call of calls) {
      const absPath = join(this.cwd, call.file_path)
      this.ensureFileOpen(absPath)
      try {
        const response = await this.client.request('textDocument/definition', {
          textDocument: { uri: `file://${absPath}` },
          position: { line: call.line, character: call.column },
        })
        if (!response) continue

        const targetLocation =
          Array.isArray(response) && response.length > 0
            ? response[0]
            : response

        if (!targetLocation?.uri) continue

        const targetUri = targetLocation.uri.replace('file://', '')
        const relPath = relative(this.cwd, targetUri)
        const targetLine =
          targetLocation.range?.start?.line ??
          targetLocation.targetSelectionRange?.start?.line

        if (targetLine === undefined) continue

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

        if (targetSymbols.length === 0) continue

        await db
          .update(schema.symbol_calls)
          .set({ callee_id: targetSymbols[0]!.id })
          .where(eq(schema.symbol_calls.id, call.call_id))
        resolvedCount++
      } catch (err) {
        logError(
          `[LSP Enhancer] Failed definition request for call ${call.call_id}`,
          err,
        )
      }
    }
    logInfo(
      `[LSP Enhancer] Resolved ${resolvedCount} out of ${calls.length} total calls.`,
    )
  }

  /** Stops the background LSP process when disposing resources. */
  async dispose(): Promise<void> {
    if (this.client) {
      await this.client.stop()
    }
  }
}
