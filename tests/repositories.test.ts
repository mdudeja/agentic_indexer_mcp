import { describe, it, expect, beforeAll } from 'bun:test'
import { IndexerDB } from '../src/database/IndexerDB'
import { InheritenceType, SymbolKind } from '../src/database/schemas'
import { randomUUID } from 'crypto'
import { getStoreForTests } from '../scripts/test_setup'
import * as schema from '../src/database/schemas'

describe('Database Repositories Unit Tests', () => {
  let store: IndexerDB

  beforeAll(async () => {
    store = getStoreForTests()
  })

  it('should test FileRepository methods', async () => {
    // 1. Upsert
    await store.files.upsert({
      path: 'src/lib.ts',
      hash: 'hash-lib',
      language: 'typescript',
      estimated_tokens: 100,
    })

    // 2. getHash
    const hash = await store.files.getHash('src/lib.ts')
    expect(hash).toBe('hash-lib')

    // 3. getAll
    const all = await store.files.getAll()
    expect(all.map((f) => f.path)).toContain('src/lib.ts')

    // 4. getByPartialNameOrPath
    const partial = await store.files.getByPartialNameOrPath('lib')
    expect(partial.length).toBe(1)
    expect(partial[0]?.path).toBe('src/lib.ts')
  })

  it('should test SymbolRepository methods', async () => {
    const symbolId = randomUUID()
    await store.symbols.upsert([
      {
        id: symbolId,
        name: 'helperFunction',
        kind: SymbolKind.function,
        file_path: 'src/lib.ts',
        line: 10,
        column: 2,
        language: 'typescript',
        exported: true,
      },
    ])

    // getDefinition
    const definition = await store.symbols.getDefinition(symbolId)
    expect(definition).toBeDefined()
    expect(definition?.name).toBe('helperFunction')

    // getSymbolsByNames
    const named = await store.symbols.getSymbolsByNames(['helperFunction'])
    expect(named.length).toBe(1)

    // search
    const results = await store.symbols.search('helper*')
    expect(results.length).toBe(2)
    expect(results[0]?.name).toBeOneOf(['helperFunction', 'helper'])
    expect(results[1]?.name).toBeOneOf(['helperFunction', 'helper'])
  })

  it('should test ImportRepository methods', async () => {
    // Ensure the parent file is upserted for foreign key constraints
    await store.files.upsert({
      path: 'src/lib.ts',
      hash: 'hash-lib',
      language: 'typescript',
      estimated_tokens: 100,
    })

    const importId = randomUUID()
    await store.imports.upsert([
      {
        id: importId,
        file_path: 'src/lib.ts',
        sourceModule: 'react',
        importedNames: ['useState'],
        edgeKind: schema.EdgeKind.Import,
        importKind: schema.ImportKind.Named,
        resolutionSource: schema.ResolutionSource.Bun,
        resolvedKind: schema.ResolvedKind.Source,
      },
    ])

    const allImports = await store.imports.getAll()
    const imports = allImports.filter((i) => i.file_path === 'src/lib.ts')

    if (imports.length !== 1) {
      console.log('DIAGNOSTICS - ImportRepository test failed:', {
        allImports,
        files: await store.files.getAll(),
      })
    }

    expect(imports.length).toBe(1)
    expect(imports[0]?.importedNames).toContain('useState')

    const singleImport = await store.imports.getById(importId)
    expect(singleImport).toBeDefined()
    expect(singleImport?.sourceModule).toBe('react')
  })

  it('should test CallSitesRepository and CallEdgesRepository methods', async () => {
    // Upsert caller and callee symbols first to prevent foreign key constraints failure
    await store.symbols.upsert([
      {
        id: 'sym-caller-1',
        name: 'callerFunction',
        kind: SymbolKind.function,
        file_path: 'src/lib.ts',
        line: 5,
        column: 2,
        language: 'typescript',
        exported: true,
      },
      {
        id: 'sym-callee-1',
        name: 'helperFunction',
        kind: SymbolKind.function,
        file_path: 'src/lib.ts',
        line: 10,
        column: 2,
        language: 'typescript',
        exported: true,
      },
    ])

    const callSiteId = randomUUID()
    await store.callSites.upsert([
      {
        id: callSiteId,
        caller_id: 'sym-caller-1',
        caller_file_path: 'src/lib.ts',
        language_name: 'typescript',
        call_text: 'helperFunction()',
        callee_expression: 'helperFunction',
        callee_name: 'helperFunction',
        call_kind: schema.CallKind.FunctionCall,
        call_line: 12,
        call_column: 4,
      },
    ])

    const sites = await store.callSites.getForSymbols(['sym-caller-1'])
    expect(sites.length).toBe(1)
    expect(sites[0]?.callee_name).toBe('helperFunction')

    // Insert a call edge for the resolved call
    await store.callEdges.upsert([
      {
        id: randomUUID(),
        call_site_id: callSiteId,
        caller_id: 'sym-caller-1',
        target_kind: schema.CallTargetKind.ProjectSymbol,
        callee_id: 'sym-callee-1',
        resolution_source: schema.CallResolutionSource.SameFile,
        confidence: 100,
      },
    ])

    const outbound = await store.callEdges.getOutboundForSymbols([
      'sym-caller-1',
    ])
    expect(outbound.length).toBe(1)
    expect(outbound[0]?.callee_name).toBe('helperFunction')
    expect(outbound[0]?.callee_id).toBe('sym-callee-1')

    const inbound = await store.callEdges.getCallers('helperFunction')
    expect(inbound.length).toBe(1)
    expect(inbound[0]?.callerName).toBe('callerFunction')
  })

  it('should test AnalysisRepository methods', async () => {
    // 1. Exceptions
    await store.analysis.upsertExceptions([
      {
        id: randomUUID(),
        symbol_id: 'sym-caller-1',
        file_path: 'src/lib.ts',
        exception_type: 'Error',
        line: 14,
        column: 6,
      },
    ])

    const exc = await store.analysis.getExceptionsBubbleUp('helperFunction')
    // Should return empty or list based on call graph
    expect(exc).toBeDefined()

    // 2. Env vars
    await store.analysis.upsertEnvVars([
      {
        id: randomUUID(),
        symbol_id: 'sym-caller-1',
        file_path: 'src/lib.ts',
        name: 'CONFIG_KEY',
        line: 15,
        column: 6,
      },
    ])

    const env = await store.analysis.getEnvVarsBubbleUp('helperFunction')
    expect(env).toBeDefined()
  })

  it('should test ToolUsageRepository methods', async () => {
    const usageId = randomUUID()
    await store.toolUsage.record({
      id: usageId,
      tool_name: 'search_symbols',
      source_tokens: 100,
      response_tokens: 20,
      tokens_saved: 80,
      called_at: Date.now(),
    })

    const summary = store.toolUsage.getTokenSavings()
    expect(summary.total_calls).toBe(1)
    expect(summary.total_tokens_saved).toBe(80)
  })

  it('should test EmbeddingRepository methods', async () => {
    const symbolId = randomUUID()
    await store.files.upsert({
      path: 'src/embed.ts',
      hash: 'hash-embed',
      language: 'typescript',
      estimated_tokens: 50,
    })
    await store.symbols.upsert([
      {
        id: symbolId,
        name: 'embedSymbol',
        kind: SymbolKind.function,
        file_path: 'src/embed.ts',
        line: 1,
        column: 1,
        language: 'typescript',
      },
    ])

    const embedding = new Array(768).fill(0.1)
    await store.embeddings.upsert(symbolId, embedding)

    const needs = await store.embeddings.getSymbolsNeedingEmbeddings([
      'src/embed.ts',
    ])
    expect(needs.length).toBe(0) // since we just updated it
  })

  it('should test EmbeddingRepository delete and searchVector', async () => {
    const symbolId = randomUUID()
    await store.files.upsert({
      path: 'src/embed2.ts',
      hash: 'hash-embed2',
      language: 'typescript',
      estimated_tokens: 50,
    })
    await store.symbols.upsert([
      {
        id: symbolId,
        name: 'embedSymbol2',
        kind: SymbolKind.function,
        file_path: 'src/embed2.ts',
        line: 1,
        column: 1,
        language: 'typescript',
      },
    ])

    const embedding = new Array(768).fill(0.2)
    await store.embeddings.upsert(symbolId, embedding)

    // searchVector should return results
    const results = store.embeddings.searchVector(embedding, 5)
    expect(Array.isArray(results)).toBe(true)
    expect(results.some((r) => r.symbol_id === symbolId)).toBe(true)

    // delete the embedding
    await store.embeddings.delete(symbolId)

    // now it should need an embedding again
    const needsAfterDelete = await store.embeddings.getSymbolsNeedingEmbeddings(
      ['src/embed2.ts'],
    )
    expect(needsAfterDelete.some((s) => s.id === symbolId)).toBe(true)

    // deleteForFile
    await store.embeddings.upsert(symbolId, embedding)
    store.embeddings.deleteForFile('src/embed2.ts')
    const needsAfterFileDelete =
      await store.embeddings.getSymbolsNeedingEmbeddings(['src/embed2.ts'])
    expect(needsAfterFileDelete.some((s) => s.id === symbolId)).toBe(true)
  })

  it('should test FileRepository getSummary, getByPath, delete, getEstimatedTokensForPaths', async () => {
    await store.files.upsert({
      path: 'src/summary.ts',
      hash: 'hash-summary',
      language: 'typescript',
      estimated_tokens: 200,
    })
    const symId = randomUUID()
    await store.symbols.upsert([
      {
        id: symId,
        name: 'summaryFn',
        kind: SymbolKind.function,
        file_path: 'src/summary.ts',
        line: 5,
        column: 0,
        language: 'typescript',
      },
    ])

    // getSummary returns symbols for file ordered by line
    const summary = await store.files.getSummary('src/summary.ts')
    expect(summary.some((s) => s.name === 'summaryFn')).toBe(true)

    // getByPath returns file record
    const byPath = await store.files.getByPath('src/summary.ts')
    expect(byPath).not.toBeNull()
    expect(byPath?.hash).toBe('hash-summary')

    // getByPath returns null for missing file
    const missing = await store.files.getByPath('nonexistent.ts')
    expect(missing).toBeNull()

    // getEstimatedTokensForPaths
    const tokens = await store.files.getEstimatedTokensForPaths([
      'src/summary.ts',
    ])
    expect(tokens).toBe(200)

    // getEstimatedTokensForPaths with empty array
    const zeroTokens = await store.files.getEstimatedTokensForPaths([])
    expect(typeof zeroTokens).toBe('number')

    // delete
    await store.files.delete('src/summary.ts')
    const afterDelete = await store.files.getByPath('src/summary.ts')
    expect(afterDelete).toBeNull()
  })

  it('should test ImportRepository getImporters, getByName, getByNameAndFile', async () => {
    await store.files.upsert({
      path: 'src/imp.ts',
      hash: 'hash-imp',
      language: 'typescript',
      estimated_tokens: 50,
    })
    const impId = randomUUID()
    await store.imports.upsert([
      {
        id: impId,
        file_path: 'src/imp.ts',
        sourceModule: 'lodash',
        importedNames: ['debounce'],
        edgeKind: schema.EdgeKind.Import,
        importKind: schema.ImportKind.Named,
        resolutionSource: schema.ResolutionSource.Bun,
        resolvedKind: schema.ResolvedKind.Source,
      },
    ])

    // getImporters
    const importers = await store.imports.getImporters('lodash')
    expect(importers.some((i) => i.importedNames?.includes('debounce'))).toBe(
      true,
    )

    // getImporters with wildcard
    const wildcardImporters = await store.imports.getImporters('lod*')
    expect(wildcardImporters.some((i) => i.sourceModule === 'lodash')).toBe(
      true,
    )

    // getByName
    const byName = await store.imports.getByName('debounce')
    expect(byName.some((i) => i.id === impId)).toBe(true)

    // getByNameAndFile
    const byNameAndFile = await store.imports.getByNameAndFile(
      'debounce',
      'src/imp.ts',
    )
    expect(byNameAndFile.length).toBeGreaterThan(0)
    expect(byNameAndFile[0]?.sourceModule).toBe('lodash')

    // getByNameAndFile with wrong file returns empty
    const wrongFile = await store.imports.getByNameAndFile(
      'debounce',
      'src/other.ts',
    )
    expect(wrongFile.length).toBe(0)
  })

  it('should test CallEdgesRepository getForCallers, getForCallees, getOutboundForSymbols, getCallersNested', async () => {
    await store.files.upsert({
      path: 'src/calls.ts',
      hash: 'hash-calls',
      language: 'typescript',
      estimated_tokens: 80,
    })
    const callerSym = randomUUID()
    const calleeSym = randomUUID()
    await store.symbols.upsert([
      {
        id: callerSym,
        name: 'mainCaller',
        kind: SymbolKind.function,
        file_path: 'src/calls.ts',
        line: 1,
        column: 0,
        language: 'typescript',
        exported: true,
      },
      {
        id: calleeSym,
        name: 'targetFn',
        kind: SymbolKind.function,
        file_path: 'src/calls.ts',
        line: 10,
        column: 0,
        language: 'typescript',
        exported: true,
      },
    ])

    // Insert a call site for callerSym calling targetFn
    const siteId = randomUUID()
    await store.callSites.upsert([
      {
        id: siteId,
        caller_id: callerSym,
        caller_file_path: 'src/calls.ts',
        language_name: 'typescript',
        call_text: 'targetFn()',
        callee_expression: 'targetFn',
        callee_name: 'targetFn',
        call_kind: schema.CallKind.FunctionCall,
        call_line: 5,
        call_column: 2,
      },
    ])

    // Insert a resolved call edge
    const edgeId = randomUUID()
    await store.callEdges.upsert([
      {
        id: edgeId,
        call_site_id: siteId,
        caller_id: callerSym,
        target_kind: schema.CallTargetKind.ProjectSymbol,
        callee_id: calleeSym,
        resolution_source: schema.CallResolutionSource.SameFile,
        confidence: 100,
      },
    ])

    // getForCallers
    const byCaller = await store.callEdges.getForCallers([callerSym])
    expect(byCaller.some((e) => e.id === edgeId)).toBe(true)

    // getForCallees
    const byCallee = await store.callEdges.getForCallees([calleeSym])
    expect(byCallee.some((e) => e.id === edgeId)).toBe(true)

    // getOutboundForSymbols joins the call site details
    const outbound = await store.callEdges.getOutboundForSymbols([callerSym])
    const edge = outbound.find((e) => e.callee_id === calleeSym)
    expect(edge).toBeDefined()
    expect(edge?.callee_name).toBe('targetFn')
    expect(edge?.call_line).toBe(5)

    // getCallers
    const callers = await store.callEdges.getCallers('targetFn')
    expect(callers.some((c) => c.callerName === 'mainCaller')).toBe(true)

    // getCallersNested
    const nested = await store.callEdges.getCallersNested('targetFn')
    expect(Array.isArray(nested)).toBe(true)

    // getCallersNestedById
    const nestedById = await store.callEdges.getCallersNestedById(calleeSym)
    expect(Array.isArray(nestedById)).toBe(true)
  })

  it('should test SymbolRepository extended methods', async () => {
    await store.files.upsert({
      path: 'src/sym-ext.ts',
      hash: 'hash-sym-ext',
      language: 'typescript',
      estimated_tokens: 150,
    })

    const parentId = randomUUID()
    const childId = randomUUID()

    await store.symbols.upsert([
      {
        id: parentId,
        name: 'ParentClass',
        kind: SymbolKind.class,
        file_path: 'src/sym-ext.ts',
        line: 1,
        column: 0,
        language: 'typescript',
        exported: true,
      },
      {
        id: childId,
        name: 'childMethod',
        kind: SymbolKind.method,
        file_path: 'src/sym-ext.ts',
        line: 3,
        column: 2,
        language: 'typescript',
        parent_id: parentId,
      },
    ])

    // getDefinitionByName
    const defByName = await store.symbols.getDefinitionByName(
      'ParentClass',
      'src/sym-ext.ts',
    )
    expect(defByName?.id).toBe(parentId)

    const missingByName = await store.symbols.getDefinitionByName(
      'ParentClass',
      'src/other.ts',
    )
    expect(missingByName).toBeNull()

    // getForFile
    const forFile = await store.symbols.getForFile('src/sym-ext.ts')
    expect(forFile.map((s) => s.id)).toContain(parentId)
    expect(forFile.map((s) => s.id)).toContain(childId)

    // getSymbolsByIds
    const byIds = await store.symbols.getSymbolsByIds([parentId, childId])
    expect(byIds.length).toBe(2)

    // getSymbolsByIds with empty array
    const emptyByIds = await store.symbols.getSymbolsByIds([])
    expect(emptyByIds.length).toBe(0)

    // getSubtree
    const subtree = await store.symbols.getSubtree(parentId)
    expect(subtree.map((s) => s.id)).toContain(parentId)
    expect(subtree.map((s) => s.id)).toContain(childId)

    // getAll includes inserted symbols
    const all = await store.symbols.getAll()
    expect(all.map((s) => s.id)).toContain(parentId)

    // getAtLocation
    const atLoc = await store.symbols.getAtLocation('src/sym-ext.ts', 1, 0)
    expect(atLoc?.id).toBe(parentId)

    const noLoc = await store.symbols.getAtLocation('src/sym-ext.ts', 99, 0)
    expect(noLoc).toBeNull()

    // getCallableAtLocation
    const callable = await store.symbols.getCallableAtLocation(
      'src/sym-ext.ts',
      3,
      2,
      [SymbolKind.method],
    )
    expect(callable?.id).toBe(childId)

    // getChildSymbols
    const children = await store.symbols.getChildSymbols(parentId)
    expect(children.map((s) => s.id)).toContain(childId)

    // updateDocstring
    await store.symbols.updateDocstring(parentId, 'A parent class.')
    const withDoc = await store.symbols.getDefinition(parentId)
    expect(withDoc?.docstring).toBe('A parent class.')

    // getSymbolsWithDocstrings
    const withDocstrings = await store.symbols.getSymbolsWithDocstrings([
      SymbolKind.class,
    ])
    expect(withDocstrings.some((s) => s.id === parentId)).toBe(true)

    // getSymbolsNeedingDocstrings (childMethod has no docstring)
    const needingDocstrings = await store.symbols.getSymbolsNeedingDocstrings([
      SymbolKind.method,
    ])
    expect(needingDocstrings.some((s) => s.id === childId)).toBe(true)

    // getSymbolsNeedingDocstringsForFile
    const needingForFile =
      await store.symbols.getSymbolsNeedingDocstringsForFile('src/sym-ext.ts', [
        SymbolKind.method,
      ])
    expect(needingForFile.some((s) => s.id === childId)).toBe(true)

    // getSymbolsNeedingDocstrings with empty kinds
    const emptyKinds = await store.symbols.getSymbolsNeedingDocstrings([])
    expect(Array.isArray(emptyKinds)).toBe(true)

    // deleteDocstring
    await store.symbols.deleteDocstring(parentId)
    const noDoc = await store.symbols.getDefinition(parentId)
    expect(noDoc?.docstring).toBeNull()

    // updateCallableSymbolTypeInfo
    await store.symbols.updateCallableSymbolTypeInfo(
      childId,
      '[{"name":"x","type":"number"}]',
      'void',
    )
    const updated = await store.symbols.getDefinition(childId)
    expect(updated?.return_type).toBe('void')
    expect(updated?.parameters_json).toBe('[{"name":"x","type":"number"}]')

    // updateSymbolInheritance
    await store.symbols.updateSymbolInheritance(parentId, [
      {
        inherits_from_name: 'BaseClass',
        inherits_from_id: 'base-id',
        inheritence_type: InheritenceType.extends,
      },
    ])
    const withInheritance = await store.symbols.getDefinition(parentId)
    expect(withInheritance?.inheritence).toBeDefined()

    // getSymbolsInheritingFrom - returns empty when no args
    const noArgs = await store.symbols.getSymbolsInheritingFrom(
      undefined,
      undefined,
    )
    expect(noArgs).toEqual([])

    // searchSymbolsHybrid with no embedding
    const hybridResults = await store.symbols.searchSymbolsHybrid(
      'ParentClass',
      null,
      undefined,
      undefined,
      undefined,
      10,
    )
    expect(Array.isArray(hybridResults)).toBe(true)
    expect(hybridResults.some((r) => r.symbol.id === parentId)).toBe(true)

    // searchSymbolsHybrid with kind filter
    const hybridByKind = await store.symbols.searchSymbolsHybrid(
      'child*',
      null,
      [SymbolKind.method],
    )
    expect(hybridByKind.every((r) => r.symbol.kind === SymbolKind.method)).toBe(
      true,
    )
  })
})
