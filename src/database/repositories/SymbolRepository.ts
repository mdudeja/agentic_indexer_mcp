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
} from 'drizzle-orm'
import * as schema from '../schemas'
import type { IndexedSymbol } from '../schemas'
import { SymbolKind } from '../schemas'
import { InheritenceType } from '../schemas/common.schema'
import type { EmbeddingRepository } from './EmbeddingRepository'

export class SymbolRepository {
  private symbolInsert: Statement | null = null
  private symbolDeleteById: Statement | null = null
  private symbolSelectIdsByFile: Statement | null = null

  constructor(
    private sqlite: Database,
    private db: SQLiteBunDatabase<typeof schema>,
    private embeddings: EmbeddingRepository,
  ) {}

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

  async getSymbolsByIds(ids: string[]): Promise<IndexedSymbol['Select'][]> {
    if (!ids.length) return []
    return this.db
      .select()
      .from(schema.symbols)
      .where(inArray(schema.symbols.id, ids))
  }

  async getSymbolsByNames(names: string[]): Promise<IndexedSymbol['Select'][]> {
    if (!names.length) return []
    return this.db
      .select()
      .from(schema.symbols)
      .where(inArray(schema.symbols.name, names))
  }

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

  async getDefinition(id: string): Promise<IndexedSymbol['Select'] | null> {
    const result = await this.db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.id, id))
      .limit(1)
    return result[0] ?? null
  }

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

  async getForFile(path: string): Promise<IndexedSymbol['Select'][]> {
    return this.db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.file_path, path))
      .orderBy(schema.symbols.line)
  }

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

  async getAll(): Promise<IndexedSymbol['Select'][]> {
    return this.db
      .select()
      .from(schema.symbols)
      .orderBy(schema.symbols.file_path, schema.symbols.line)
  }

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
          or(
            isNull(schema.symbols.docstring),
            eq(schema.symbols.docstring, ''),
          ),
        ),
      )
      .orderBy(schema.symbols.file_path, schema.symbols.line)
  }

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
          or(
            isNull(schema.symbols.docstring),
            eq(schema.symbols.docstring, ''),
          ),
        ),
      )
      .orderBy(schema.symbols.line)
  }

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

  async updateDocstring(id: string, docstring: string): Promise<void> {
    await this.db
      .update(schema.symbols)
      .set({ docstring })
      .where(eq(schema.symbols.id, id))
  }

  async deleteDocstring(id: string): Promise<void> {
    await this.db
      .update(schema.symbols)
      .set({ docstring: null })
      .where(eq(schema.symbols.id, id))
  }

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

  async updateSymbolInheritance(
    symbolId: string,
    inheritsFromNames: string,
    inheritenceType: InheritenceType,
  ): Promise<void> {
    await this.db
      .update(schema.symbols)
      .set({
        inherits_from_names: inheritsFromNames,
        inheritence_type: inheritenceType,
      })
      .where(eq(schema.symbols.id, symbolId))
  }

  async getSymbolsInheritingFrom(
    baseName: string,
  ): Promise<IndexedSymbol['Select'][]> {
    return this.db
      .select()
      .from(schema.symbols)
      .where(
        or(
          eq(schema.symbols.inherits_from_names, baseName),
          like(schema.symbols.inherits_from_names, `${baseName},%`),
          like(schema.symbols.inherits_from_names, `%,${baseName}`),
          like(schema.symbols.inherits_from_names, `%,${baseName},%`),
        ),
      )
      .orderBy(schema.symbols.file_path, schema.symbols.line)
  }

  async getChildSymbols(parentId: string): Promise<IndexedSymbol['Select'][]> {
    return this.db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.parent_id, parentId))
      .orderBy(schema.symbols.line)
  }

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
