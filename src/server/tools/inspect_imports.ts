import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolResult } from './index'
import { IndexerDB } from 'src/database/IndexerDB'
import { z } from 'zod'
import { updateUsage } from 'src/utils/updateUsage'
import { formatResolutionAnnotation } from './helpers/format'

enum IMPORTS_MODE {
  imports_for_file = 'imports_for_file',
  import_by_id = 'import_by_id',
  dependency_cycles = 'dependency_cycles',
}

/** Registers the inspect_imports tool: import/dependency analysis. */
export function registerInspectImportsTool(server: McpServer) {
  server.registerTool(
    'inspect_imports',
    {
      title: 'Inspect Imports',
      description:
        'Analyze imports and module dependencies. ' +
        '\n\n' +
        'THREE MODES: ' +
        '`imports_for_file` — list all imports for a given file. ' +
        '`import_by_id` — retrieve details for a specific import by its ID. ' +
        '`dependency_cycles` — detect circular import dependencies using Tarjan SCC. ' +
        '\n\n' +
        'WHEN TO USE: To understand module dependencies, resolve import issues, and find circular imports that cause initialization bugs.',
      inputSchema: z.object({
        mode: z
          .enum(IMPORTS_MODE)
          .default(IMPORTS_MODE.imports_for_file)
          .describe('What to inspect (default: imports_for_file)'),
        filePath: z
          .string()
          .optional()
          .describe('File path to get imports for (imports_for_file mode)'),
        id: z
          .string()
          .optional()
          .describe('Import ID to retrieve (import_by_id mode)'),
        limit: z
          .number()
          .optional()
          .describe('Max results (imports_for_file mode, default 100)'),
        max_cycles: z
          .number()
          .default(20)
          .optional()
          .describe(
            'Max cycles to return (dependency_cycles mode, default 20)',
          ),
      }),
    },
    async (args) => {
      const store = IndexerDB.getInstance()
      const mode = args.mode ?? IMPORTS_MODE.imports_for_file

      switch (mode) {
        case IMPORTS_MODE.imports_for_file:
          if (!args.filePath) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'imports_for_file mode requires filePath.',
                },
              ],
              isError: true,
            }
          }
          return importsForFile(store, args.filePath, args.limit)
        case IMPORTS_MODE.import_by_id:
          if (!args.id) {
            return {
              content: [
                { type: 'text', text: 'import_by_id mode requires id.' },
              ],
              isError: true,
            }
          }
          return importById(store, args.id)
        case IMPORTS_MODE.dependency_cycles:
          return dependencyCycles(store, args.max_cycles ?? 20)
        default:
          return {
            content: [{ type: 'text', text: `Unsupported mode: ${mode}` }],
            isError: true,
          }
      }
    },
  )
}

/** Lists all imports for a given file. */
async function importsForFile(
  store: IndexerDB,
  filePath: string,
  limit?: number,
): Promise<ToolResult> {
  try {
    const results = await store.imports.getByPartialFilePath(filePath, limit)

    if (results.length === 0) {
      return {
        content: [
          { type: 'text', text: 'No imports found for the specified file.' },
        ],
      }
    }

    const output = results
      .map((i) => {
        const annotation = formatResolutionAnnotation({
          confidence: i.confidence,
          resolutionSource: i.resolutionSource,
        })
        return `- [${i.id}] import ${i.importedNames?.join(', ') || '*'} from '${i.sourceModule}'${annotation}${i.resolvedPath ? ` → ${i.resolvedPath}` : ''}`
      })
      .join('\n')

    const outputText = `Found ${results.length} imports in ${filePath}:\n\n${output}`
    await updateUsage('inspect_imports', [filePath], outputText.length, true)
    return { content: [{ type: 'text', text: outputText }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error getting imports: ${err}` }],
      isError: true,
    }
  }
}

/** Retrieves details for a specific import by its ID. */
async function importById(store: IndexerDB, id: string): Promise<ToolResult> {
  try {
    const result = await store.imports.getById(id)

    if (!result) {
      return {
        content: [
          { type: 'text', text: 'No import found with the specified ID.' },
        ],
      }
    }

    const annotation = formatResolutionAnnotation({
      confidence: result.confidence,
      resolutionSource: result.resolutionSource,
    })
    const outputText = `Import ID: ${result.id}\nFile: ${result.file_path}\nModule: ${result.sourceModule}\nImported Names: ${result.importedNames?.join(', ') || '*'}${annotation}\nResolved: ${result.resolvedPath ?? 'unresolved'} (kind: ${result.resolvedKind})`
    await updateUsage(
      'inspect_imports',
      [result.file_path],
      outputText.length,
      true,
    )
    return { content: [{ type: 'text', text: outputText }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error getting import by ID: ${err}` }],
      isError: true,
    }
  }
}

/** Detects circular import dependencies using Tarjan's SCC algorithm. */
async function dependencyCycles(
  store: IndexerDB,
  max_cycles: number,
): Promise<ToolResult> {
  try {
    const maxCycles = max_cycles ?? 20

    const allFiles = await store.files.getAll()
    const filePathSet = new Set(allFiles.map((f) => f.path))
    const allImports = await store.imports.getAll()

    const adj = new Map<string, Set<string>>()
    for (const imp of allImports) {
      if (
        !filePathSet.has(imp.file_path) ||
        !filePathSet.has(imp.resolvedPath ?? '')
      ) {
        continue
      }
      if (imp.file_path === imp.resolvedPath) continue
      const set = adj.get(imp.file_path) ?? new Set<string>()
      set.add(imp.resolvedPath ?? '')
      adj.set(imp.file_path, set)
    }

    if (adj.size === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No intra-project import edges found. Either the project has no relative imports or the index is empty.',
          },
        ],
      }
    }

    const index = new Map<string, number>()
    const lowlink = new Map<string, number>()
    const onStack = new Set<string>()
    const stack: string[] = []
    const cycles: string[][] = []
    let counter = 0

    const nodes = [...adj.keys()]
    for (const startNode of nodes) {
      if (index.has(startNode)) continue

      type Frame = { node: string; neighbours: string[]; ni: number }
      const callStack: Frame[] = []

      /** Handles the visit process for the given identifier. */
      const visit = (v: string) => {
        index.set(v, counter)
        lowlink.set(v, counter)
        counter++
        stack.push(v)
        onStack.add(v)
        callStack.push({ node: v, neighbours: [...(adj.get(v) ?? [])], ni: 0 })
      }

      visit(startNode)

      while (callStack.length > 0) {
        const frame = callStack[callStack.length - 1]!
        if (frame.ni < frame.neighbours.length) {
          const w = frame.neighbours[frame.ni++]!
          if (!index.has(w)) {
            visit(w)
          } else if (onStack.has(w)) {
            lowlink.set(
              frame.node,
              Math.min(lowlink.get(frame.node)!, index.get(w)!),
            )
          }
        } else {
          callStack.pop()
          if (callStack.length > 0) {
            const parent = callStack[callStack.length - 1]!
            lowlink.set(
              parent.node,
              Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!),
            )
          }
          if (lowlink.get(frame.node) === index.get(frame.node)) {
            const scc: string[] = []
            let w: string
            do {
              w = stack.pop()!
              onStack.delete(w)
              scc.push(w)
            } while (w !== frame.node)
            if (scc.length > 1) cycles.push(scc)
          }
        }
      }
    }

    if (cycles.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No circular dependencies found across ${allFiles.length} indexed files. The import graph is a DAG.`,
          },
        ],
      }
    }

    cycles.sort((a, b) => b.length - a.length)
    const topCycles = cycles.slice(0, maxCycles)

    const lines: string[] = [
      `Found ${cycles.length} circular dependency cycle${cycles.length !== 1 ? 's' : ''} (showing top ${topCycles.length}):\n`,
    ]
    topCycles.forEach((cycle, i) => {
      lines.push(`Cycle ${i + 1} (${cycle.length} files):`)
      for (const file of cycle) lines.push(`  → ${file}`)
      lines.push(`  ↩ (back to ${cycle[cycle.length - 1]})`)
      lines.push('')
    })
    lines.push(
      'Tip: use explore_architecture (mode=coupling_metrics) to measure the instability impact. Consider dependency injection or barrel re-exports to break cycles.',
    )

    const output = lines.join('\n')
    await updateUsage(
      'inspect_imports',
      allFiles.map((f) => f.path),
      output.length,
    )
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [
        { type: 'text', text: `Error detecting dependency cycles: ${err}` },
      ],
      isError: true,
    }
  }
}
