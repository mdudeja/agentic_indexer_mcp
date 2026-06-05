import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { eq, and, isNull, isNotNull, inArray } from 'drizzle-orm'
import * as schema from '../../database/schemas'
import { SymbolKind } from '../../database/schemas'
import { AppStateManager } from 'src/state'
import { allCodebaseLanguages } from 'src/utils/allCodebaseLanguages'
import { allCallableKinds } from 'src/utils/allCallableKinds'

const ALL_KINDS = Object.keys(SymbolKind) as (keyof typeof SymbolKind)[]

/** Registers a tool to identify dead code — exported symbols never imported or called, and internal symbols never called. */
export function registerFindDeadCodeTool(server: McpServer) {
  server.registerTool(
    'find_dead_code',
    {
      title: 'Find Dead Code',
      description:
        'Identify symbols that appear to be unreachable: (1) exported top-level symbols that are never imported and never called by any other indexed symbol, and (2) non-exported callable symbols that are never called. Best-effort — dynamic calls (obj[method]()) and symbols consumed via namespace imports (import * as X) will not be detected. Run after a full index for accurate results.',
      inputSchema: z.object({
        kind: z
          .array(z.enum(ALL_KINDS))
          .optional()
          .describe(
            'Filter by symbol kinds. Defaults to all callable/declarative kinds.',
          ),
        exclude_tests: z
          .boolean()
          .default(true)
          .describe('Exclude symbols defined in test files (default true).'),
        limit: z
          .number()
          .default(50)
          .describe('Maximum number of dead symbols to return (default 50).'),
      }),
    },
    async ({ kind, exclude_tests, limit }) => {
      const store = IndexerDB.getInstance()
      const TEST_RE =
        AppStateManager.getInstance()
          .getItem('config')
          ?.testFilePatterns.map((p) => {
            if (p instanceof RegExp) return p
            if (typeof p === 'string') return new RegExp(p)
            return null
          })
          .filter((p): p is RegExp => p !== null) ?? null
      try {
        const db = store.getDb()
        const kinds = (kind as string[] | undefined) ?? [...ALL_KINDS]
        const maxLimit = (limit as number) ?? 50

        // Collect all imported names across the entire codebase
        const allImportedRows = await db
          .select({ name: schema.imports.imported_name })
          .from(schema.imports)
        const importedNameSet = new Set(
          allImportedRows
            .map((i) => i.name)
            .filter((n): n is string => n != null),
        )

        // Collect all resolved callee IDs
        const allCalleeRows = await db
          .select({ id: schema.symbol_calls.callee_id })
          .from(schema.symbol_calls)
          .where(isNotNull(schema.symbol_calls.callee_id))
        const calledIdSet = new Set(
          allCalleeRows
            .map((c) => c.id)
            .filter((id): id is string => id != null),
        )

        const inheritanceCoveredIdSet = await getInheritenceCoveredIds(
          store,
          calledIdSet,
        )

        // --- Category 1: exported top-level symbols never imported and never called ---
        const exportedSymbols = await db
          .select()
          .from(schema.symbols)
          .where(
            and(
              eq(schema.symbols.exported, true),
              isNull(schema.symbols.parent_id),
              inArray(schema.symbols.kind, kinds as SymbolKind[]),
            ),
          )
          .orderBy(schema.symbols.file_path, schema.symbols.line)

        const deadExports = exportedSymbols.filter((s) => {
          if (exclude_tests && TEST_RE?.some((re) => re.test(s.file_path)))
            return false
          return (
            !importedNameSet.has(s.name) &&
            !calledIdSet.has(s.id) &&
            !inheritanceCoveredIdSet.has(s.id)
          )
        })

        // --- Category 2: non-exported callable symbols never called ---
        const callableKinds = await allCallableKinds()
        const internalSymbols = await db
          .select()
          .from(schema.symbols)
          .where(
            and(
              eq(schema.symbols.exported, false),
              inArray(schema.symbols.kind, callableKinds),
            ),
          )
          .orderBy(schema.symbols.file_path, schema.symbols.line)

        const deadInternal = internalSymbols.filter((s) => {
          if (exclude_tests && TEST_RE?.some((re) => re.test(s.file_path)))
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

        // remove constructors from the list (they are technically callable but often not directly called and can be misleading in dead code results)
        const languages = await allCodebaseLanguages()
        const constructorPatterns = Array.from(languages!).flatMap((lang) => {
          return (
            AppStateManager.getInstance().getItem('config')?.languages?.[lang]
              ?.treesitter?.constructor_pattern ?? []
          )
        })
        const filteredDead = allDead.filter((s) => {
          for (const pattern of constructorPatterns) {
            if (s.kind === pattern.kind && s.name === pattern.name) {
              return false
            }
          }
          return true
        })

        // Group by file
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
            const tag = s.exported
              ? '[exported, unreferenced]'
              : '[never called]'
            lines.push(`  ${s.kind} ${s.name} (line ${s.line + 1}) ${tag}`)
          }
          lines.push('')
        }

        lines.push(
          'Note: dynamic calls, namespace imports, and reflection-based usage are not detected.',
        )

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error finding dead code: ${err}` }],
          isError: true,
        }
      }
    },
  )
}

/** This function identifies and records the IDs of methods whose calls are covered through inheritance within a class hierarchy.
 * It processes both direct method calls and those resolved via imports to determine if they inherit from parent classes, marking these as covered. */
async function getInheritenceCoveredIds(
  store: IndexerDB,
  calledIdSet: Set<string>,
) {
  const db = store.getDb()
  const inheritanceCoveredIdSet = new Set<string>()
  const calledByTypeName = new Map<string, Set<string>>()

  // Source A: callee_id resolved — follow parent_id to get the parent class name.
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

  // Source B: imports_id resolved — follow imports to get the imported name, which may match a parent class name.
  const viaImportRows = await db
    .select({
      callee_name: schema.symbol_calls.callee_name,
      imported_name: schema.imports.imported_name,
    })
    .from(schema.symbol_calls)
    .innerJoin(
      schema.imports,
      eq(schema.symbol_calls.imports_id, schema.imports.id),
    )
    .where(isNull(schema.symbol_calls.callee_id))

  for (const row of viaImportRows) {
    if (!row.imported_name || !row.callee_name) continue
    const names = calledByTypeName.get(row.imported_name) ?? new Set<string>()
    names.add(row.callee_name)
    calledByTypeName.set(row.imported_name, names)
  }

  // Find child classes (via inherits_from_names) and mark matching methods covered.
  if (calledByTypeName.size > 0) {
    const allCalledMethodNames = new Set<string>()
    for (const names of calledByTypeName.values()) {
      names.forEach((n) => allCalledMethodNames.add(n))
    }

    const childClasses = await db
      .select({
        id: schema.symbols.id,
        inherits_from_names: schema.symbols.inherits_from_names,
      })
      .from(schema.symbols)
      .where(isNotNull(schema.symbols.inherits_from_names))

    // classId → parentTypeName (only for parents that have called methods)
    const classIdToParentName = new Map<string, string>()
    for (const cls of childClasses) {
      if (!cls.inherits_from_names) continue
      for (const parentName of cls.inherits_from_names
        .split(',')
        .map((n) => n.trim())) {
        if (!calledByTypeName.has(parentName)) continue
        classIdToParentName.set(cls.id, parentName)
        break // one parent per class (by assumption)
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
