import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { SymbolKind } from '../../database/schemas'

const SORT_OPTIONS = [
  'instability',
  'distance',
  'afferent',
  'efferent',
] as const

/** Registers a tool to compute Robert C. Martin's coupling metrics for each indexed file. */
export function registerGetCouplingMetricsTool(server: McpServer) {
  server.registerTool(
    'get_coupling_metrics',
    {
      title: 'Get Coupling Metrics',
      description:
        "Compute Robert C. Martin's package coupling metrics for each indexed file:\n" +
        '  Ce  — Efferent coupling: number of distinct files this file imports from\n' +
        '  Ca  — Afferent coupling: number of distinct files that import this file\n' +
        '  I   — Instability: Ce / (Ce + Ca). 0 = maximally stable, 1 = maximally unstable\n' +
        '  A   — Abstractness: ratio of interface/type symbols to total symbols\n' +
        '  D   — Distance from main sequence: |A + I - 1|. Lower is better.\n\n' +
        'Files far from the main sequence are either overly abstract with no dependents (Zone of Uselessness) or highly coupled and concrete (Zone of Pain).',
      inputSchema: z.object({
        sort_by: z
          .enum(SORT_OPTIONS)
          .default('distance')
          .describe(
            'Sort results by: distance (default), instability, afferent (Ca), or efferent (Ce).',
          ),
        limit: z
          .number()
          .default(30)
          .describe('Maximum number of files to return (default 30).'),
        min_symbols: z
          .number()
          .default(1)
          .describe(
            'Minimum number of symbols a file must have to be included (default 1, filters empty/stub files).',
          ),
      }),
    },
    async ({ sort_by, limit, min_symbols }) => {
      const store = IndexerDB.getInstance()
      try {
        const sortKey = (sort_by as (typeof SORT_OPTIONS)[number]) ?? 'distance'
        const maxLimit = (limit as number) ?? 30
        const minSymbols = (min_symbols as number) ?? 1

        // Get all indexed files and imports
        const allFiles = await store.getAllFiles()
        const filePathSet = new Set(allFiles.map((f) => f.path))
        const allImports = await store.getAllImports()
        const allSymbols = await store.getAllSymbols()

        // Build Ce (efferent) and Ca (afferent) maps — only intra-project edges
        const ceMap = new Map<string, Set<string>>() // file → set of files it imports
        const caMap = new Map<string, Set<string>>() // file → set of files that import it

        for (const imp of allImports) {
          if (
            !filePathSet.has(imp.file_path) ||
            !filePathSet.has(imp.module_path)
          ) {
            continue
          }
          if (imp.file_path === imp.module_path) continue

          const ce = ceMap.get(imp.file_path) ?? new Set<string>()
          ce.add(imp.module_path)
          ceMap.set(imp.file_path, ce)

          const ca = caMap.get(imp.module_path) ?? new Set<string>()
          ca.add(imp.file_path)
          caMap.set(imp.module_path, ca)
        }

        // Build abstractness map (interface/type symbols / total symbols per file)
        const abstractKinds = new Set<string>([
          SymbolKind.interface,
          SymbolKind.type,
        ])
        type Counts = { total: number; abstract: number }
        const symbolCounts = new Map<string, Counts>()

        for (const sym of allSymbols) {
          const counts = symbolCounts.get(sym.file_path) ?? {
            total: 0,
            abstract: 0,
          }
          counts.total++
          if (abstractKinds.has(sym.kind)) counts.abstract++
          symbolCounts.set(sym.file_path, counts)
        }

        // Compute metrics for each file
        type FileMetrics = {
          file: string
          Ce: number
          Ca: number
          I: number
          A: number
          D: number
          totalSymbols: number
        }

        const metrics: FileMetrics[] = []
        for (const file of allFiles) {
          const counts = symbolCounts.get(file.path) ?? {
            total: 0,
            abstract: 0,
          }
          if (counts.total < minSymbols) continue

          const Ce = ceMap.get(file.path)?.size ?? 0
          const Ca = caMap.get(file.path)?.size ?? 0
          const I = Ce + Ca > 0 ? Ce / (Ce + Ca) : 0
          const A = counts.total > 0 ? counts.abstract / counts.total : 0
          const D = Math.abs(A + I - 1)

          metrics.push({
            file: file.path,
            Ce,
            Ca,
            I,
            A,
            D,
            totalSymbols: counts.total,
          })
        }

        if (metrics.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No files with symbols found in the index.',
              },
            ],
          }
        }

        // Sort
        metrics.sort((a, b) => {
          switch (sortKey) {
            case 'distance':
              return b.D - a.D
            case 'instability':
              return b.I - a.I
            case 'afferent':
              return b.Ca - a.Ca
            case 'efferent':
              return b.Ce - a.Ce
          }
        })

        const topMetrics = metrics.slice(0, maxLimit)

        // Format output as aligned table
        const header = `${'Ce'.padStart(4)}  ${'Ca'.padStart(4)}  ${'I'.padStart(6)}  ${'A'.padStart(6)}  ${'D'.padStart(6)}  File`
        const separator = '─'.repeat(80)
        const rows = topMetrics.map(
          (m) =>
            `${String(m.Ce).padStart(4)}  ${String(m.Ca).padStart(4)}  ${m.I.toFixed(2).padStart(6)}  ${m.A.toFixed(2).padStart(6)}  ${m.D.toFixed(2).padStart(6)}  ${m.file}`,
        )

        const lines = [
          `Coupling metrics for ${topMetrics.length} of ${metrics.length} files (sorted by ${sortKey}):\n`,
          header,
          separator,
          ...rows,
          '',
          'Ce=efferent, Ca=afferent, I=instability (0=stable,1=unstable), A=abstractness, D=distance from main sequence',
          'High D + high I + low A = Zone of Pain (concrete and depended-upon). High D + low I + high A = Zone of Uselessness.',
        ]

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
        }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Error computing coupling metrics: ${err}` },
          ],
          isError: true,
        }
      }
    },
  )
}
