import { GenericLspEnhancer } from './GenericLspEnhancer'
import * as schema from '../../database/schemas/index.ts'
import { eq, and, isNull, inArray } from 'drizzle-orm'
import { SymbolKind } from '../../database/schemas/index.ts'
import { logInfo } from 'src/utils/logger.ts'
import { PythonCallEdgeResolver } from '../resolvers/callEdgeResolvers/PythonCallEdgeResolver.ts'

/** Specialized LSP enhancer for Python, extending generic LSP capabilities with language-specific optimizations and features. */
export class PythonLspEnhancer extends GenericLspEnhancer {
  /** Initializes resources and prepares for operation. Returns true if successful, false otherwise. */
  override async init(): Promise<boolean> {
    const superReturn = await super.init()
    if (!superReturn) {
      return false
    }

    try {
      this.callEdgeResolver = new PythonCallEdgeResolver(
        this.client!,
        this.languageId,
      )
      return superReturn
    } catch (err) {
      logInfo(
        `Failed to initialize PythonCallEdgeResolver: ${err}`,
        'PythonLspEnhancer',
      )
      return false
    }
  }
  /** Enhances interface inheritance by resolving missing inheritance information for classes in specified files. */
  override async enhanceInterfaceInheritence(
    relPaths: string[],
  ): Promise<void> {
    if (!this.available || !this.client) {
      return
    }

    let totalResolved = 0

    const unresolvedClasses = await this.db
      .select()
      .from(schema.symbols)
      .where(
        and(
          eq(schema.symbols.language, this.languageId),
          eq(schema.symbols.kind, SymbolKind.class),
          isNull(schema.symbols.inheritence),
          relPaths.length > 0
            ? inArray(schema.symbols.file_path, relPaths)
            : undefined,
        ),
      )

    const file_paths = Array.from(
      new Set(unresolvedClasses.map((s) => s.file_path)),
    )
    const importsByFile = await this.loadImportsByFile(file_paths)
    const symbolsByFile = await this.loadSymbolsByFile(file_paths)

    for (const symbol of unresolvedClasses) {
      const inheritenceItems = await this.generateInheritenceForSymbol(
        symbol,
        importsByFile.get(symbol.file_path),
        symbolsByFile.get(symbol.file_path),
      )

      if (!inheritenceItems || inheritenceItems.length === 0) {
        continue
      }

      await this.db
        .update(schema.symbols)
        .set({
          inheritence: inheritenceItems,
        })
        .where(eq(schema.symbols.id, symbol.id))

      totalResolved++
    }

    logInfo(
      `[PythonLspEnhancer - - Interface Inheritance] Resolved inheritence for ${totalResolved} classes out of ${unresolvedClasses.length} unresolved classes.`,
    )
  }

  /** Extracts inherited items from a class declaration based on its constructor parameters. */
  private async getInheritsFromItems(
    symbol: schema.IndexedSymbol['Select'],
  ): Promise<string[] | null> {
    const signatureText = symbol.signature
    if (!signatureText) {
      return null
    }

    const inheritenceMatches = signatureText.match(/class\s+\w+\(([^)]*)\)/)
    if (!inheritenceMatches || inheritenceMatches.length < 2) {
      return null
    }

    const inheritenceList = inheritenceMatches[1]!
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    const separatedInheritenceList: string[] = []
    const separatorRegex = /(\.|\[|\])/g
    for (const inheritence of inheritenceList) {
      separatedInheritenceList.push(
        ...inheritence
          .split(separatorRegex)
          .map((s) => s.trim().replaceAll('"', '').replaceAll("'", ''))
          .filter((s) => s.length > 0),
      )
    }

    return Array.from(new Set(separatedInheritenceList))
  }

  /** Generates inheritance relationships for a given symbol by analyzing its inherited types, determining if they are imported or locally defined. Returns an array of inheritance items specifying the type and source of each inheritance. */
  private async generateInheritenceForSymbol(
    symbol: schema.IndexedSymbol['Select'],
    importsByFile: schema.IndexedImport['Select'][] | undefined,
    symbolsByFile: schema.IndexedSymbol['Select'][] | undefined,
  ): Promise<schema.Inheritence[]> {
    const inheritenceNames = await this.getInheritsFromItems(symbol)
    if (!inheritenceNames || inheritenceNames.length === 0) {
      return []
    }
    const inheritenceItems: schema.Inheritence[] = []
    for (const inheritenceName of inheritenceNames) {
      const importId = this.resolveImportIdByType(
        [inheritenceName],
        importsByFile,
      )
      if (!importId) {
        const localSymbolId = symbolsByFile?.find(
          (s) => s.name === inheritenceName,
        )?.id

        if (!localSymbolId) {
          continue
        }

        inheritenceItems.push({
          inheritence_type: schema.InheritenceType.extends,
          inherits_from_name: inheritenceName,
          inherits_from_id: localSymbolId,
        })
        continue
      }
      inheritenceItems.push({
        inheritence_type: schema.InheritenceType.extends,
        inherits_from_name: inheritenceName,
        inherits_from_imports_id: importId,
      })
    }
    return inheritenceItems
  }
}
