import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolResult } from './index'
import { IndexerDB } from 'src/database/IndexerDB'
import { z } from 'zod'
import { updateUsage } from 'src/utils/updateUsage'
import {
  eq,
  and,
  isNull,
  isNotNull,
  inArray,
  sql,
  like,
  not,
  type SQL,
} from 'drizzle-orm'
import * as schema from 'src/database/schemas'
import { SymbolKind } from 'src/database/schemas'
import { allCallableKinds } from 'src/utils/allCallableKinds'
import { doesPathMatch, getTestFileGlobs } from 'src/utils/pathGlobs'
import { simpleGit } from 'simple-git'
import { AppStateManager } from 'src/state'
import { parseParameters } from './helpers'

const ALL_KINDS = Object.keys(SymbolKind) as (keyof typeof SymbolKind)[]

enum QUALITY_MODE {
  dead_code = 'dead_code',
  untested_symbols = 'untested_symbols',
  similar_patterns = 'similar_patterns',
  importance = 'importance',
  hotspots = 'hotspots',
}

const DAMPING = 0.85
const ITERATIONS = 30

/** Registers the analyze_quality tool: code health assessment. */
export function registerAnalyzeQualityTool(server: McpServer) {
  server.registerTool(
    'analyze_quality',
    {
      title: 'Analyze Quality',
      description:
        'Assess code health and quality. ' +
        '\n\n' +
        'FIVE MODES: ' +
        '`dead_code` — unreferenced exports and never-called internals. ' +
        '`untested_symbols` — exported symbols in files not imported by any test. ' +
        '`similar_patterns` — symbols with the same structural shape as a reference (kind, return type, param count, decorator, inheritance). ' +
        '`importance` — PageRank centrality ranking across the call graph. ' +
        '`hotspots` — high-churn + high-complexity files (git hotspots); pass --file for a symbol-level breakdown. ' +
        '\n\n' +
        'WHEN TO USE: For audits, refactor planning, and test-coverage gaps. ' +
        'Use `dead_code` for cleanup, `untested_symbols` for coverage gaps, `similar_patterns` to apply a fix consistently, ' +
        '`coupling_metrics` for architectural review, `importance` to find critical symbols, and `hotspots` to find where bugs concentrate.',
      inputSchema: z.object({
        mode: z
          .enum(QUALITY_MODE)
          .default(QUALITY_MODE.dead_code)
          .describe('What to analyze (default: dead_code)'),
        kind: z
          .array(z.enum(ALL_KINDS))
          .optional()
          .describe(
            'Filter by symbol kind (dead_code/untested_symbols/importance modes)',
          ),
        exclude_tests: z
          .boolean()
          .default(true)
          .optional()
          .describe('Exclude test files (dead_code/importance modes)'),
        limit: z
          .number()
          .default(50)
          .optional()
          .describe('Max results (dead_code/untested_symbols/hotspots modes)'),
        symbol_name: z
          .string()
          .optional()
          .describe('Reference symbol name (similar_patterns mode)'),
        file_path: z
          .string()
          .optional()
          .describe(
            'File path to disambiguate (similar_patterns mode) or hotspot file (hotspots mode)',
          ),
        match_on: z
          .array(
            z.enum([
              'kind',
              'return_type',
              'param_count',
              'decorator',
              'inheritence',
            ]),
          )
          .optional()
          .describe('Which attributes to match on (similar_patterns mode)'),
      }),
    },
    async (args) => {
      const store = IndexerDB.getInstance()
      const mode = args.mode ?? QUALITY_MODE.dead_code
      const kind = args.kind as SymbolKind[]

      switch (mode) {
        case QUALITY_MODE.dead_code:
          return deadCode(store, kind, args.exclude_tests, args.limit)
        case QUALITY_MODE.untested_symbols:
          return untestedSymbols(
            store,
            args.kind as string[] | undefined,
            args.limit,
          )
        case QUALITY_MODE.similar_patterns:
          if (!args.symbol_name) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'similar_patterns mode requires symbol_name.',
                },
              ],
              isError: true,
            }
          }
          return similarPatterns(
            store,
            args.symbol_name,
            args.file_path,
            args.match_on,
          )
        case QUALITY_MODE.importance:
          return importance(
            store,
            args.limit,
            args.kind as (keyof typeof SymbolKind)[] | undefined,
            args.exclude_tests,
          )
        case QUALITY_MODE.hotspots:
          return hotspots(store, args.limit ?? 20, args.file_path)
        default:
          return {
            content: [{ type: 'text', text: `Unsupported mode: ${mode}` }],
            isError: true,
          }
      }
    },
  )
}

/** Identifies dead code — exported symbols never imported/called, and internal symbols never called. */
async function deadCode(
  store: IndexerDB,
  kind?: SymbolKind[],
  exclude_tests = true,
  limit = 50,
): Promise<ToolResult> {
  const testFileGlobs = getTestFileGlobs()
  try {
    const kinds = kind ?? [...ALL_KINDS]
    const maxLimit = limit ?? 50

    const allImportedRows = await store.imports.getAll()
    const importedNameSet = new Set(
      allImportedRows
        .map((i) => i.importedNames)
        .flat()
        .filter((n): n is string => n != null),
    )

    const allCalleeRows = await store.callEdges.getAllWithCalleeIds()
    const calledIdSet = new Set(
      allCalleeRows
        .map((c) => c.callee)
        .filter((id): id is string => id != null),
    )

    const inheritanceCoveredIdSet = await getInheritenceCoveredIds(
      store,
      calledIdSet,
    )

    const exportedSymbols = await store.symbols.getEntrypointSymbols(
      kinds as SymbolKind[],
    )

    const deadExports = exportedSymbols.filter((s) => {
      if (exclude_tests && doesPathMatch(testFileGlobs, s.file_path))
        return false
      return (
        !importedNameSet.has(s.name) &&
        !calledIdSet.has(s.id) &&
        !inheritanceCoveredIdSet.has(s.id)
      )
    })

    const internalSymbols = await store.symbols.getInternalCallableSymbols()

    const deadInternal = internalSymbols.filter((s) => {
      if (exclude_tests && doesPathMatch(testFileGlobs, s.file_path))
        return false
      return !calledIdSet.has(s.id) && !inheritanceCoveredIdSet.has(s.id)
    })

    const allDead = [...deadExports, ...deadInternal].slice(0, maxLimit)
    if (allDead.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No dead code detected. All indexed symbols appear to be reachable.',
          },
        ],
      }
    }

    const filteredDead = allDead.filter((s) => {
      if (
        s.kind === SymbolKind.method &&
        (s.name === 'constructor' || s.name === '__init__' || s.name === 'new')
      ) {
        return false
      }
      return true
    })

    const byFile = new Map<string, typeof filteredDead>()
    for (const s of filteredDead) {
      const list = byFile.get(s.file_path) ?? []
      list.push(s)
      byFile.set(s.file_path, list)
    }

    const lines: string[] = [
      `Found ${filteredDead.length} potentially dead symbol${filteredDead.length !== 1 ? 's' : ''}:\n`,
    ]
    for (const [file, symbols] of byFile) {
      lines.push(`${file}`)
      for (const s of symbols) {
        const tag = s.exported ? '[exported, unreferenced]' : '[never called]'
        lines.push(`  ${s.kind} ${s.name} (line ${s.line + 1}) ${tag}`)
      }
      lines.push('')
    }
    lines.push(
      'Note: dynamic calls, namespace imports, and reflection-based usage are not detected.',
    )

    const output = lines.join('\n')
    await updateUsage('analyze_quality', [...byFile.keys()], output.length)
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error finding dead code: ${err}` }],
      isError: true,
    }
  }
}

/** Identifies and records IDs of methods whose calls are covered through inheritance. */
async function getInheritenceCoveredIds(
  store: IndexerDB,
  calledIdSet: Set<string>,
) {
  const db = store.getDb()
  const inheritanceCoveredIdSet = new Set<string>()
  const calledByTypeName = new Map<string, Set<string>>()

  if (calledIdSet.size > 0) {
    const calledMethods = await db
      .select({
        name: schema.symbols.name,
        parent_id: schema.symbols.parent_id,
      })
      .from(schema.symbols)
      .where(inArray(schema.symbols.id, [...calledIdSet]))

    const parentedMethods = calledMethods.filter(
      (m): m is typeof m & { parent_id: string } => m.parent_id != null,
    )
    if (parentedMethods.length > 0) {
      const parentIds = [...new Set(parentedMethods.map((m) => m.parent_id))]
      const parentSymbols = await db
        .select({ id: schema.symbols.id, name: schema.symbols.name })
        .from(schema.symbols)
        .where(inArray(schema.symbols.id, parentIds))
      const parentIdToName = new Map(parentSymbols.map((p) => [p.id, p.name]))
      for (const m of parentedMethods) {
        const typeName = parentIdToName.get(m.parent_id)
        if (!typeName) continue
        const names = calledByTypeName.get(typeName) ?? new Set<string>()
        names.add(m.name)
        calledByTypeName.set(typeName, names)
      }
    }
  }

  const viaImportRows = await db
    .select({
      callee_name: schema.call_sites.callee_name,
      imported_names: schema.imports.importedNames,
    })
    .from(schema.call_edges)
    .innerJoin(
      schema.call_sites,
      eq(schema.call_sites.id, schema.call_edges.call_site_id),
    )
    .innerJoin(
      schema.imports,
      eq(schema.call_edges.imports_id, schema.imports.id),
    )
    .where(isNull(schema.call_edges.callee_id))

  for (const row of viaImportRows) {
    if (
      !row.imported_names ||
      row.imported_names.length === 0 ||
      !row.callee_name
    )
      continue
    for (const importedName of row.imported_names) {
      const names = calledByTypeName.get(importedName) ?? new Set<string>()
      names.add(row.callee_name)
      calledByTypeName.set(importedName, names)
    }
  }

  if (calledByTypeName.size > 0) {
    const allCalledMethodNames = new Set<string>()
    for (const names of calledByTypeName.values()) {
      names.forEach((n) => allCalledMethodNames.add(n))
    }

    const childClasses = await db
      .select({
        id: schema.symbols.id,
        inheritence: schema.symbols.inheritence,
      })
      .from(schema.symbols)
      .where(isNotNull(schema.symbols.inheritence))

    const classIdToParentName = new Map<string, string>()
    for (const cls of childClasses) {
      if (!cls.inheritence || !cls.inheritence.length) continue
      for (const parent of cls.inheritence) {
        const parentName = parent.inherits_from_name
        if (!calledByTypeName.has(parentName)) continue
        classIdToParentName.set(cls.id, parentName)
        break
      }
    }

    if (classIdToParentName.size > 0) {
      const childMethods = await db
        .select({
          id: schema.symbols.id,
          name: schema.symbols.name,
          parent_id: schema.symbols.parent_id,
        })
        .from(schema.symbols)
        .where(
          and(
            inArray(schema.symbols.parent_id, [...classIdToParentName.keys()]),
            inArray(schema.symbols.name, [...allCalledMethodNames]),
          ),
        )
      for (const m of childMethods) {
        if (!m.parent_id) continue
        const parentName = classIdToParentName.get(m.parent_id)
        if (!parentName) continue
        if (calledByTypeName.get(parentName)?.has(m.name)) {
          inheritanceCoveredIdSet.add(m.id)
        }
      }
    }
  }

  return inheritanceCoveredIdSet
}

/** Lists exported callable symbols in files not imported by any test file. */
async function untestedSymbols(
  store: IndexerDB,
  kind?: string[],
  limit = 50,
): Promise<ToolResult> {
  try {
    const db = store.getDb()
    const callableKinds = await allCallableKinds()
    const kinds = kind ?? [...callableKinds, SymbolKind.class]
    const maxLimit = limit ?? 50

    const testFileGlobs = getTestFileGlobs()
    const allFiles = await store.files.getAll()
    const testFilePaths = new Set(
      allFiles
        .filter((f) => doesPathMatch(testFileGlobs, f.path))
        .map((f) => f.path),
    )

    if (testFilePaths.size === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No test files found in the indexed workspace. Cannot determine test coverage.',
          },
        ],
      }
    }

    const testImports = await db
      .select({ resolvedPath: schema.imports.resolvedPath })
      .from(schema.imports)
      .where(inArray(schema.imports.file_path, [...testFilePaths]))
    const testCoveredPaths = new Set(testImports.map((i) => i.resolvedPath))

    const allFilePaths = allFiles.map((f) => f.path)
    const nonTestPaths = allFilePaths.filter(
      (p) => !testFilePaths.has(p) && !testCoveredPaths.has(p),
    )

    if (nonTestPaths.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'All non-test files are imported by test files. No untested symbols found.',
          },
        ],
      }
    }

    const untestedSymbols = await db
      .select()
      .from(schema.symbols)
      .where(
        and(
          eq(schema.symbols.exported, true),
          inArray(
            schema.symbols.parent_id,
            db
              .select({ id: schema.symbols.id })
              .from(schema.symbols)
              .where(eq(schema.symbols.name, '<module>')),
          ),
          inArray(schema.symbols.kind, kinds as SymbolKind[]),
          inArray(schema.symbols.file_path, nonTestPaths),
        ),
      )
      .orderBy(schema.symbols.file_path, schema.symbols.line)
      .limit(maxLimit)

    if (untestedSymbols.length === 0) {
      return {
        content: [
          { type: 'text', text: 'No untested exported symbols found.' },
        ],
      }
    }

    const byFile = new Map<string, typeof untestedSymbols>()
    for (const s of untestedSymbols) {
      const list = byFile.get(s.file_path) ?? []
      list.push(s)
      byFile.set(s.file_path, list)
    }

    const lines: string[] = [
      `Found ${untestedSymbols.length} untested exported symbol${untestedSymbols.length !== 1 ? 's' : ''} in ${byFile.size} file${byFile.size !== 1 ? 's' : ''}`,
      `(${testFilePaths.size} test files cover ${testCoveredPaths.size} source files directly)\n`,
    ]
    for (const [file, symbols] of byFile) {
      lines.push(file)
      for (const s of symbols) {
        lines.push(`  ${s.kind} ${s.name} (line ${s.line + 1})`)
      }
      lines.push('')
    }
    lines.push(
      'Note: 1-hop import analysis only. Transitive imports are not traced.',
    )

    const output = lines.join('\n')
    await updateUsage('analyze_quality', [], output.length)
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [
        { type: 'text', text: `Error finding untested symbols: ${err}` },
      ],
      isError: true,
    }
  }
}

/** Finds symbols with structurally similar patterns to a reference symbol. */
async function similarPatterns(
  store: IndexerDB,
  symbol_name: string,
  file_path?: string,
  match_on?: string[],
): Promise<ToolResult> {
  try {
    const name = symbol_name
    const matchDims = match_on ?? [
      'kind',
      'return_type',
      'param_count',
      'decorator',
      'inheritence',
    ]
    const db = store.getDb()

    const candidates = await store.symbols.search(
      name,
      undefined,
      file_path as string | undefined,
      undefined,
      5,
    )
    if (candidates.length === 0) {
      return {
        content: [
          { type: 'text', text: `Symbol '${name}' not found in index.` },
        ],
      }
    }
    if (candidates.length > 1 && !file_path) {
      return {
        content: [
          {
            type: 'text',
            text: `Multiple symbols named '${name}' found. Please specify a file_path to disambiguate.`,
          },
        ],
      }
    }

    const target = candidates[0]!

    const targetParamCount = parseParameters(target)?.length ?? 0

    const conditions: SQL[] = [not(eq(schema.symbols.id, target.id))]
    if (matchDims.includes('kind')) {
      conditions.push(eq(schema.symbols.kind, target.kind))
    }
    if (matchDims.includes('return_type') && target.return_type) {
      conditions.push(
        like(schema.symbols.return_type, `%${target.return_type}%`),
      )
    }
    if (matchDims.includes('decorator') && target.decorator) {
      conditions.push(eq(schema.symbols.decorator, target.decorator))
    }
    if (
      matchDims.includes('inheritence') &&
      target.inheritence &&
      target.inheritence.length > 0
    ) {
      const inheritanceConditions = target.inheritence.map((i) => {
        const nameCond = sql`json_extract(value, '$.inherits_from_name') = ${i.inherits_from_name}`
        const idConds: SQL[] = []
        if (i.inherits_from_id) {
          idConds.push(
            sql`json_extract(value, '$.inherits_from_id') = ${i.inherits_from_id}`,
          )
        }
        if (i.inherits_from_imports_id) {
          idConds.push(
            sql`json_extract(value, '$.inherits_from_imports_id') = ${i.inherits_from_imports_id}`,
          )
        }
        if (idConds.length > 0) {
          return sql`(${nameCond} AND (${sql.join(idConds, sql` OR `)}))`
        } else {
          return nameCond
        }
      })
      conditions.push(
        sql`EXISTS (SELECT 1 FROM json_each(inheritence) WHERE ${sql.join(inheritanceConditions, sql` OR `)})`,
      )
    }

    let results = await db
      .select()
      .from(schema.symbols)
      .where(and(...conditions))
      .limit(100)

    if (matchDims.includes('param_count') && targetParamCount !== null) {
      results = results.filter((s) => {
        if (!s.parameters_json) return targetParamCount === 0
        try {
          return (
            (JSON.parse(s.parameters_json) as unknown[]).length ===
            targetParamCount
          )
        } catch {
          return false
        }
      })
    }

    results = results.slice(0, 20)
    if (results.length === 0) {
      const matchDesc = matchDims.join(', ')
      return {
        content: [
          {
            type: 'text',
            text: `No similar patterns found for '${name}' matching on: ${matchDesc}`,
          },
        ],
      }
    }

    const targetDesc = [
      `kind: ${target.kind}`,
      target.return_type ? `returns: ${target.return_type}` : null,
      targetParamCount !== null
        ? `${targetParamCount} param${targetParamCount !== 1 ? 's' : ''}`
        : null,
      target.decorator ? `@${target.decorator}` : null,
    ]
      .filter(Boolean)
      .join(', ')

    const resultLines = results.map((s) => {
      let paramDesc = ''
      if (s.parameters_json) {
        try {
          const params = JSON.parse(s.parameters_json) as Array<{
            name: string
            type?: string
          }>
          paramDesc =
            params.length > 0
              ? `(${params.map((p) => `${p.name}: ${p.type ?? '?'}`).join(', ')})`
              : '()'
        } catch {
          paramDesc = ''
        }
      }
      let line = `  [${s.kind.toUpperCase()}] ${s.name} (${s.file_path}:${s.line + 1})`
      if (s.decorator) line += ` @${s.decorator}`
      if (s.return_type) line += `\n    Returns: ${s.return_type}`
      if (paramDesc) line += `\n    Params: ${paramDesc}`
      if (s.docstring) line += `\n    Doc: ${s.docstring.split('\n')[0]}`
      return line
    })

    const output = `Symbols similar to: ${name} (${targetDesc})\n\nFound ${results.length} similar pattern${results.length !== 1 ? 's' : ''}:\n\n${resultLines.join('\n\n')}`
    const filePaths = new Set(results.map((s) => s.file_path))
    await updateUsage('analyze_quality', Array.from(filePaths), output.length)
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [
        { type: 'text', text: `Error finding similar patterns: ${err}` },
      ],
      isError: true,
    }
  }
}

/** Ranks symbols by structural importance using PageRank on the call graph. */
async function importance(
  store: IndexerDB,
  limit?: number,
  kind?: (keyof typeof SymbolKind)[],
  exclude_tests = true,
): Promise<ToolResult> {
  try {
    const maxLimit = limit ?? 20

    const edges = await store.callEdges.getAllWithCalleeIds()

    if (edges.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No resolved call edges found. Re-index the project to populate the call graph.',
          },
        ],
      }
    }

    const nodeIds = new Set<string>()
    for (const e of edges) {
      nodeIds.add(e.caller)
      if (e.callee) nodeIds.add(e.callee)
    }
    const N = nodeIds.size

    const outEdges = new Map<string, string[]>()
    for (const e of edges) {
      if (!e.callee) continue
      const list = outEdges.get(e.caller) ?? []
      list.push(e.callee)
      outEdges.set(e.caller, list)
    }

    let rank = new Map<string, number>()
    for (const id of nodeIds) rank.set(id, 1 / N)
    for (let i = 0; i < ITERATIONS; i++) {
      const newRank = new Map<string, number>()
      for (const id of nodeIds) newRank.set(id, (1 - DAMPING) / N)
      for (const [caller, callees] of outEdges) {
        const contribution =
          (DAMPING * (rank.get(caller) ?? 0)) / callees.length
        for (const callee of callees) {
          newRank.set(callee, (newRank.get(callee) ?? 0) + contribution)
        }
      }
      rank = newRank
    }

    const sorted = [...rank.entries()].sort((a, b) => b[1] - a[1])
    const fetchIds = sorted.slice(0, maxLimit * 5).map(([id]) => id)
    const symbols = await store.symbols.getSymbolsByIds(fetchIds)
    const symbolMap = new Map(symbols.map((s) => [s.id, s]))

    const testFileGlobs = getTestFileGlobs()
    const results: Array<{ symbol: (typeof symbols)[0]; score: number }> = []
    for (const [id, score] of sorted) {
      if (results.length >= maxLimit) break
      const sym = symbolMap.get(id)
      if (!sym) continue
      if (exclude_tests && doesPathMatch(testFileGlobs, sym.file_path)) continue
      if (kind && kind.length > 0 && !kind.includes(sym.kind as any)) continue
      results.push({ symbol: sym, score })
    }

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No symbols matched the filters after PageRank computation.',
          },
        ],
      }
    }

    const lines: string[] = [
      `Top ${results.length} symbols by call-graph importance (PageRank, d=${DAMPING}):\n`,
      `${'Rank'.padEnd(6)} ${'Score'.padEnd(10)} ${'Kind'.padEnd(14)} ${'Symbol'}\n${'─'.repeat(70)}`,
    ]
    results.forEach(({ symbol: s, score }, i) => {
      lines.push(
        `${String(i + 1).padEnd(6)} ${score.toFixed(6).padEnd(10)} ${s.kind.padEnd(14)} ${s.name}  ${s.file_path}:${s.line + 1}`,
      )
    })

    const output = lines.join('\n')
    await updateUsage(
      'analyze_quality',
      results.map((r) => r.symbol.file_path),
      output.length,
    )
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [
        { type: 'text', text: `Error computing symbol importance: ${err}` },
      ],
      isError: true,
    }
  }
}

/** Finds high-churn + high-complexity files (git hotspots). */
async function hotspots(
  store: IndexerDB,
  limit: number,
  file?: string,
): Promise<ToolResult> {
  const cwd = AppStateManager.getInstance().getItem('root') ?? process.cwd()
  try {
    const maxLimit = limit ?? 20
    const git = simpleGit(cwd)

    // Get per-file churn via git log --numstat
    const numstat = await git.raw(['log', '--numstat', '--pretty=format:'])
    const churnMap = new Map<
      string,
      { commits: number; added: number; removed: number }
    >()

    if (numstat && numstat.trim().length > 0) {
      for (const line of numstat.split('\n')) {
        const parts = line.trim().split('\t')
        if (parts.length < 3) continue
        const addedStr = parts[0]
        const removedStr = parts[1]
        const filePath = parts[2]
        if (!filePath || filePath === '-') continue
        const added = parseInt(addedStr ?? '', 10) || 0
        const removed = parseInt(removedStr ?? '', 10) || 0
        const entry = churnMap.get(filePath) ?? {
          commits: 0,
          added: 0,
          removed: 0,
        }
        entry.added += added
        entry.removed += removed
        churnMap.set(filePath, entry)
      }
    }

    if (churnMap.size === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No git churn data found. Ensure the workspace is a git repository with commit history.',
          },
        ],
      }
    }

    // If a specific file is requested, show its symbol-level breakdown
    if (file) {
      const resolved = await store.files.getByPartialNameOrPath(file)
      if (resolved.length === 0) {
        return {
          content: [{ type: 'text', text: `File not found: ${file}` }],
          isError: true,
        }
      }
      const filePath = resolved[0]!.path
      const churn = churnMap.get(filePath)
      if (!churn) {
        return {
          content: [
            { type: 'text', text: `No git churn data for file: ${filePath}` },
          ],
        }
      }

      const symbols = await store.symbols.getForFile(filePath)
      const output = `Hotspot breakdown for ${filePath}:\n\nTotal churn: ${churn.added} added, ${churn.removed} removed lines\n\nSymbols in this file (by line range):\n${symbols
        .map(
          (s) =>
            `  - ${s.kind} ${s.name} (lines ${s.line + 1}-${(s.end_line ?? s.line) + 1})`,
        )
        .join('\n')}`
      await updateUsage('analyze_quality', [filePath], output.length)
      return { content: [{ type: 'text', text: output }] }
    }

    // Otherwise rank files by churn weighted by complexity (symbol count)
    const allFiles = await store.files.getAll()
    const symbolCounts = new Map<string, number>()
    const allSymbols = await store.symbols.getAll()
    for (const sym of allSymbols) {
      symbolCounts.set(
        sym.file_path,
        (symbolCounts.get(sym.file_path) ?? 0) + 1,
      )
    }

    const ranked = allFiles
      .map((f) => {
        const churn = churnMap.get(f.path)
        if (!churn) return null
        const complexity = symbolCounts.get(f.path) ?? 0
        const churnScore = churn.added + churn.removed
        const hotspotScore = churnScore * (1 + complexity / 10)
        return { file: f.path, ...churn, complexity, hotspotScore }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.hotspotScore - a.hotspotScore)
      .slice(0, maxLimit)

    if (ranked.length === 0) {
      return {
        content: [{ type: 'text', text: 'No hotspot files found.' }],
      }
    }

    const lines: string[] = [
      `Top ${ranked.length} hotspot files (churn weighted by complexity):\n`,
      `${'Score'.padEnd(10)} ${'Added'.padEnd(8)} ${'Removed'.padEnd(8)} ${'Symbols'.padEnd(8)} File`,
      '─'.repeat(80),
    ]
    for (const r of ranked) {
      lines.push(
        `${r.hotspotScore.toFixed(1).padEnd(10)} ${String(r.added).padEnd(8)} ${String(r.removed).padEnd(8)} ${String(r.complexity).padEnd(8)} ${r.file}`,
      )
    }
    lines.push(
      '\nPass --file to see the symbol-level breakdown for a specific hotspot file.',
    )

    const output = lines.join('\n')
    await updateUsage(
      'analyze_quality',
      allFiles.map((f) => f.path),
      output.length,
    )
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error computing hotspots: ${err}` }],
      isError: true,
    }
  }
}
