import { Database, Statement } from 'bun:sqlite'
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite'
import {
  eq,
  like,
  SQL,
  and,
  getColumns,
  inArray,
  isNull,
  or,
  not,
  isNotNull,
  sql,
  ne,
} from 'drizzle-orm'
import * as schema from '../schemas'
import type { IndexedSymbol } from '../schemas'
import { SymbolKind } from '../schemas'
import { type Inheritence } from '../schemas/common.schema'
import type { EmbeddingRepository } from './EmbeddingRepository'

/** A class that provides database operations for managing symbol data, including insertion, deletion, retrieval, synchronization, and querying of symbols based on various criteria. */
export class SymbolRepository {
  private symbolInsert: Statement | null = null
  private symbolDeleteById: Statement | null = null
  private symbolSelectIdsByFile: Statement | null = null

  /** This constructor initializes the dependencies required for the class, including a SQLite database connection, embeddings repository, and schema utilities. */
  constructor(
    private sqlite: Database,
    private db: SQLiteBunDatabase<typeof schema>,
    private embeddings: EmbeddingRepository,
  ) {}

  /** Initializes SQLite database statements for symbol-related operations. */
  initStatements() {
    const cols = Object.keys(getColumns(schema.symbols))
    this.symbolInsert = this.sqlite.prepare(
      `INSERT INTO symbols (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    )
    this.symbolDeleteById = this.sqlite.prepare(
      `DELETE FROM symbols WHERE id = ?`,
    )
    this.symbolSelectIdsByFile = this.sqlite.prepare(
      `SELECT id FROM symbols WHERE file_path = ?`,
    )
  }

  /** This method processes a list of symbols to either insert or delete records based on whether they exist in the current dataset, ensuring synchronization with the provided data. */
  async upsert(symbolsData: IndexedSymbol['Insert'][]): Promise<void> {
    if (
      !symbolsData.length ||
      !this.symbolInsert ||
      !this.symbolDeleteById ||
      !this.symbolSelectIdsByFile
    )
      return

    const symbolCols = Object.keys(getColumns(schema.symbols))

    this.sqlite.transaction(() => {
      const byFile = new Map<string, IndexedSymbol['Insert'][]>()
      for (const s of symbolsData) {
        const arr = byFile.get(s.file_path) ?? []
        arr.push(s)
        byFile.set(s.file_path, arr)
      }

      for (const [filePath, newSymbols] of byFile) {
        const oldIds = (
          this.symbolSelectIdsByFile!.all(filePath) as { id: string }[]
        ).map((r) => r.id)
        const oldIdSet = new Set(oldIds)
        const newIdSet = new Set(newSymbols.map((s) => s.id))

        for (const id of oldIds) {
          if (!newIdSet.has(id)) {
            this.embeddings.deleteForFile(filePath)
            this.symbolDeleteById!.run(id)
          }
        }

        for (const item of newSymbols) {
          if (!oldIdSet.has(item.id)) {
            const s = { ...item, exported: Boolean(item.exported) }
            const args = symbolCols.map((col) => (s as any)[col] ?? null)
            this.symbolInsert!.run(...args)
          }
        }
      }
    })()
  }

  /** Retrieves symbols from a database based on provided IDs. */
  async getSymbolsByIds(ids: string[]): Promise<IndexedSymbol['Select'][]> {
    if (!ids.length) return []
    return this.db
      .select()
      .from(schema.symbols)
      .where(inArray(schema.symbols.id, ids))
  }

  /** "Retrieves symbols matching the specified names." */
  async getSymbolsByNames(names: string[]): Promise<IndexedSymbol['Select'][]> {
    if (!names.length) return []
    return this.db
      .select()
      .from(schema.symbols)
      .where(inArray(schema.symbols.name, names))
  }

  /** Searches for symbols matching the given query string, optionally filtering by symbol kind, file path pattern, and limiting results. */
  async search(
    queryStr: string,
    kind?: SymbolKind | 'all',
    filePattern?: string,
    limitVal: number = 20,
  ): Promise<IndexedSymbol['Select'][]> {
    const conditions: SQL[] = [
      like(schema.symbols.name, queryStr.replace(/\*/g, '%')),
    ]
    if (kind && kind !== 'all') conditions.push(eq(schema.symbols.kind, kind))
    if (filePattern) {
      conditions.push(
        like(
          schema.symbols.file_path,
          `%${filePattern.replace(/\*/g, '%')}%`.replace(/%+/g, '%'),
        ),
      )
    }
    return this.db
      .select()
      .from(schema.symbols)
      .where(and(...conditions))
      .limit(limitVal)
  }

  /** Retrieves the definition of a symbol based on its unique identifier from the database. Returns the symbol data if found, or `null` if no matching symbol exists. */
  async getDefinition(id: string): Promise<IndexedSymbol['Select'] | null> {
    const result = await this.db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.id, id))
      .limit(1)
    return result[0] ?? null
  }

  /** Retrieves the definition of a symbol by its name and the file path. */
  async getDefinitionByName(
    name: string,
    path: string,
  ): Promise<IndexedSymbol['Select'] | null> {
    const result = await this.db
      .select()
      .from(schema.symbols)
      .where(
        and(eq(schema.symbols.name, name), eq(schema.symbols.file_path, path)),
      )
      .limit(1)
    return result[0] ?? null
  }

  /** Retrieves all symbols associated with a specific file, ordered by their line number. */
  async getForFile(path: string): Promise<IndexedSymbol['Select'][]> {
    return this.db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.file_path, path))
      .orderBy(schema.symbols.line)
  }

  /** Retrieves all symbols in the subtree of the specified symbol, including its descendants, and returns their hierarchical data as an array. */
  async getSubtree(symbolId: string): Promise<IndexedSymbol['Select'][]> {
    const rows = this.sqlite
      .prepare(
        `WITH RECURSIVE subtree AS (
           SELECT * FROM symbols WHERE id = ?
           UNION ALL
           SELECT s.* FROM symbols s INNER JOIN subtree t ON s.parent_id = t.id
         )
         SELECT * FROM subtree ORDER BY line`,
      )
      .all(symbolId) as any[]
    return rows.map((row) => ({
      ...row,
      exported: Boolean(row.exported),
    })) as IndexedSymbol['Select'][]
  }

  /** Retrieves all symbols from the database, ordered by their file path and line number. */
  async getAll(): Promise<IndexedSymbol['Select'][]> {
    return this.db
      .select()
      .from(schema.symbols)
      .orderBy(schema.symbols.file_path, schema.symbols.line)
  }

  /** Retrieves the symbol located at the specified file and line number. Returns null if no symbol exists at that location. */
  async getAtLocation(
    filePath: string,
    line: number,
  ): Promise<IndexedSymbol['Select'] | null> {
    const result = await this.db
      .select()
      .from(schema.symbols)
      .where(
        and(
          eq(schema.symbols.file_path, filePath),
          eq(schema.symbols.line, line),
        ),
      )
      .limit(1)
    return result[0] ?? null
  }

  /** "Retrieves the callable symbol at the specified location if one exists." */
  async getCallableAtLocation(
    filePath: string,
    line: number,
    callableKinds: SymbolKind[],
  ): Promise<IndexedSymbol['Select'] | null> {
    const result = await this.db
      .select()
      .from(schema.symbols)
      .where(
        and(
          eq(schema.symbols.file_path, filePath),
          eq(schema.symbols.line, line),
          inArray(schema.symbols.kind, callableKinds),
        ),
      )
      .limit(1)
    return result[0] ?? null
  }

  /** Retrieves all symbols of the specified kinds that currently lack a docstring or have an empty one. */
  async getSymbolsNeedingDocstrings(
    targetKinds: SymbolKind[],
  ): Promise<IndexedSymbol['Select'][]> {
    if (!targetKinds.length) return []
    return this.db
      .select()
      .from(schema.symbols)
      .where(
        and(
          inArray(schema.symbols.kind, targetKinds),
          ne(schema.symbols.name, '<module>'),
          or(
            isNull(schema.symbols.docstring),
            eq(schema.symbols.docstring, ''),
          ),
        ),
      )
      .orderBy(schema.symbols.file_path, schema.symbols.line)
  }

  /** Get symbols within a specified file that require docstrings. This includes symbols of specified kinds that either lack a docstring or have an empty one. */
  async getSymbolsNeedingDocstringsForFile(
    relativePath: string,
    targetKinds: SymbolKind[],
  ): Promise<IndexedSymbol['Select'][]> {
    if (!targetKinds.length) return []
    return this.db
      .select()
      .from(schema.symbols)
      .where(
        and(
          eq(schema.symbols.file_path, relativePath),
          inArray(schema.symbols.kind, targetKinds),
          ne(schema.symbols.name, '<module>'),
          or(
            isNull(schema.symbols.docstring),
            eq(schema.symbols.docstring, ''),
          ),
        ),
      )
      .orderBy(schema.symbols.line)
  }

  /** Retrieves symbols with docstrings for specified kinds. */
  async getSymbolsWithDocstrings(
    targetKinds: SymbolKind[],
  ): Promise<IndexedSymbol['Select'][]> {
    if (!targetKinds.length) return []
    return this.db
      .select()
      .from(schema.symbols)
      .where(
        and(
          inArray(schema.symbols.kind, targetKinds),
          and(
            isNotNull(schema.symbols.docstring),
            not(eq(schema.symbols.docstring, '')),
          ),
        ),
      )
      .orderBy(schema.symbols.file_path, schema.symbols.line)
  }

  /** Updates the docstring for the symbol identified by id. */
  async updateDocstring(id: string, docstring: string): Promise<void> {
    await this.db
      .update(schema.symbols)
      .set({ docstring })
      .where(eq(schema.symbols.id, id))
  }

  /** Delete the docstring of the symbol with the specified ID. */
  async deleteDocstring(id: string): Promise<void> {
    await this.db
      .update(schema.symbols)
      .set({ docstring: null })
      .where(eq(schema.symbols.id, id))
  }

  /** "Updates the type information for a callable symbol by setting its parameters and return type." */
  async updateCallableSymbolTypeInfo(
    symbolId: string,
    parametersJson: string,
    returnType: string,
  ): Promise<void> {
    await this.db
      .update(schema.symbols)
      .set({ parameters_json: parametersJson, return_type: returnType })
      .where(eq(schema.symbols.id, symbolId))
  }

  /** Updates the inheritance properties of a symbol in the database. */
  async updateSymbolInheritance(
    symbolId: string,
    inheritence: Inheritence[],
  ): Promise<void> {
    const existingInheritence = await this.db
      .select({ inheritence: schema.symbols.inheritence })
      .from(schema.symbols)
      .where(eq(schema.symbols.id, symbolId))
      .limit(1)

    const existing = existingInheritence[0]?.inheritence ?? []
    const merged = [...existing, ...inheritence]
    const uniqueMerged = Array.from(
      new Map(merged.map((i) => [i.inherits_from_name, i])).values(),
    )

    await this.db
      .update(schema.symbols)
      .set({
        inheritence: uniqueMerged,
      })
      .where(eq(schema.symbols.id, symbolId))
  }

  /** Retrieves all symbols that inherit from the specified base symbol. */
  async getSymbolsInheritingFrom(
    symbolName?: string,
    symbolId?: string,
  ): Promise<IndexedSymbol['Select'][]> {
    if (!symbolName && !symbolId) {
      return []
    }
    let baseQuery = 'EXISTS (SELECT 1 FROM json_each(inheritence) WHERE'

    if (symbolId) {
      baseQuery += ` json_extract(value, '$.inherits_from_id') = ${symbolId}`

      if (symbolName) {
        baseQuery += ` AND `
      }
    }

    if (symbolName) {
      baseQuery += ` json_extract(value, '$.inherits_from_name') = ${symbolName}`
    }

    baseQuery += ')'

    return this.db
      .select()
      .from(schema.symbols)
      .where(sql<Boolean>`${baseQuery}`)
      .orderBy(schema.symbols.file_path, schema.symbols.line)
  }

  /** "Retrieves all child symbols of a given parent symbol based on the provided parent ID. The returned list is ordered by their line number." */
  async getChildSymbols(parentId: string): Promise<IndexedSymbol['Select'][]> {
    return this.db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.parent_id, parentId))
      .orderBy(schema.symbols.line)
  }

  /** Searches for symbols using a hybrid approach combining text-based and semantic (embedding) matching, returning the most relevant results based on combined text and semantic relevance scores. */
  async searchSymbolsHybrid(
    queryStr: string,
    queryEmbedding: number[] | null,
    kind?: SymbolKind | 'all',
    filePattern?: string,
    limitVal: number = 20,
  ): Promise<Array<{ symbol: IndexedSymbol['Select']; score: number }>> {
    const textMatches = await this.search(
      queryStr,
      kind,
      filePattern,
      limitVal * 2,
    )
    const semanticMatches = queryEmbedding
      ? this.embeddings.searchVector(queryEmbedding, limitVal * 2)
      : []

    const scores = new Map<
      string,
      {
        symbol: IndexedSymbol['Select']
        textRank: number
        semanticRank: number
      }
    >()

    /** Retrieves or initializes a record for the specified ID with the provided symbol and default rank values. */
    const getRecord = (id: string, sym: IndexedSymbol['Select']) => {
      if (!scores.has(id))
        scores.set(id, {
          symbol: sym,
          textRank: Infinity,
          semanticRank: Infinity,
        })
      return scores.get(id)!
    }

    textMatches.forEach((sym, index) => {
      getRecord(sym.id, sym).textRank = index + 1
    })

    if (semanticMatches.length > 0) {
      const symMap = new Map(
        (
          await this.getSymbolsByIds(semanticMatches.map((m) => m.symbol_id))
        ).map((s) => [s.id, s]),
      )
      semanticMatches.forEach((match, index) => {
        const sym = symMap.get(match.symbol_id)
        if (!sym) return
        if (kind && kind !== 'all' && sym.kind !== kind) return
        if (
          filePattern &&
          !sym.file_path.includes(filePattern.replace(/\*/g, ''))
        )
          return
        getRecord(sym.id, sym).semanticRank = index + 1
      })
    }

    const K = 60
    return Array.from(scores.values())
      .map((rec) => ({
        symbol: rec.symbol,
        score:
          (rec.textRank === Infinity ? 0 : 1 / (K + rec.textRank)) +
          (rec.semanticRank === Infinity ? 0 : 1 / (K + rec.semanticRank)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limitVal)
  }
}
