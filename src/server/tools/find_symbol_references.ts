import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import type { NestedCaller } from 'src/database/types'
import type { IndexedImport, IndexedSymbol } from 'src/database/schemas'
import { updateUsage } from 'src/utils/updateUsage'

/** Registers a tool to find all references to a symbol — both call sites and import locations. Supersedes find_importers with symbol-level precision. */
export function registerFindSymbolReferencesTool(server: McpServer) {
  server.registerTool(
    'find_symbol_references',
    {
      title: 'Find Symbol References',
      description:
        'Find every place in the codebase that references a symbol or module. ' +
        '\n\n' +
        'FOUR REFERENCE TYPES RETURNED: ' +
        '(1) Call sites — functions that invoke the symbol (with file:line). ' +
        '(2) Named imports — files that import the symbol by name (`import { foo } from ...`). ' +
        "(3) Module importers — files that import the symbol's containing module (only when input looks like a path). " +
        '(4) Inheriters — symbols that inherit from the symbol (with file:line).' +
        '\n\n' +
        'HOW TO CALL: Pass a symbol name to find call sites and named imports. ' +
        'Pass a file path (containing `/` or `.`) to also find module-level importers. ' +
        'Use `file_pattern` to restrict results to a subsystem. ' +
        '\n\n' +
        'WHEN TO USE: Before renaming or deleting a symbol, to find all sites that need updating. ' +
        'To understand how widely a utility is used. ' +
        'Compared to `get_blast_radius`: this is a flat 1-hop reference lookup; ' +
        '`get_blast_radius` does a full BFS up the entire call chain to find transitive dependents. ' +
        '\n\n' +
        'If the symbol name is ambiguous, provide `file_pattern` to disambiguate.',
      inputSchema: z.object({
        symbol_name: z
          .string()
          .describe(
            'Symbol name to find references for, or a file path (containing / or .) to find module importers.',
          ),
        file_pattern: z
          .string()
          .optional()
          .describe('Filter by file path pattern (supports * wildcard)'),
        include_imports: z
          .boolean()
          .default(true)
          .describe('Include files that import this symbol by name'),
        include_calls: z
          .boolean()
          .default(true)
          .describe('Include call sites where this symbol is invoked'),
        include_inheritors: z
          .boolean()
          .default(true)
          .describe('Include symbols that inherit from this symbol'),
      }),
    },
    async ({
      symbol_name,
      file_pattern,
      include_imports,
      include_calls,
      include_inheritors,
    }) => {
      const store = IndexerDB.getInstance()
      try {
        let allCallers: NestedCaller[] = [],
          importRefs: IndexedImport['Select'][] = [],
          moduleImporters: IndexedImport['Select'][] = [],
          inheritors: IndexedSymbol['Select'][] = []

        const name = symbol_name as string
        const sections: string[] = []

        const symbols = await store.symbols.search(
          name,
          'all',
          file_pattern as string | undefined,
        )

        if (symbols.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Symbol '${name}' not found in codebase.`,
              },
            ],
          }
        }

        if (symbols.length > 1 && !file_pattern) {
          return {
            content: [
              {
                type: 'text',
                text: `Multiple symbols found with name '${name}'. Please provide a file_pattern to disambiguate.`,
              },
            ],
          }
        }

        const symbol = symbols[0]

        if (include_calls) {
          allCallers = await store.calls.getCallersNested(symbol!.name)
          if (allCallers.length > 0) {
            const callLines = allCallers.map(
              (c) =>
                `  - ${c.callerName}${c.childName ? ` (${symbol!.name}.${c.childName})` : ''} in ${c.callerFile}:${c.line + 1}`,
            )
            sections.push(
              `Called at (${allCallers.length} location${allCallers.length !== 1 ? 's' : ''}):\n${callLines.join('\n')}`,
            )
          } else {
            sections.push(`Called at: (none found)`)
          }
        }

        if (include_imports) {
          importRefs = await store.imports.getByName(symbol!.name)
          if (importRefs.length > 0) {
            const importLines = importRefs.map(
              (i) => `  - ${i.file_path} (from '${i.module_path}')`,
            )
            sections.push(
              `Imported by name in (${importRefs.length} file${importRefs.length !== 1 ? 's' : ''}):\n${importLines.join('\n')}`,
            )
          } else {
            sections.push(`Imported by name: (none found)`)
          }
        }

        if (include_inheritors) {
          inheritors = await store.symbols.getSymbolsInheritingFrom(
            symbol!.name,
            symbol!.id,
          )
          if (inheritors.length > 0) {
            const inheritorLines = inheritors.map(
              (i) => `  - ${i.name} in ${i.file_path}:${i.line + 1}`,
            )
            sections.push(
              `Inherited by (${inheritors.length} symbol${inheritors.length !== 1 ? 's' : ''}):\n${inheritorLines.join('\n')}`,
            )
          } else {
            sections.push(`Inherited by: (none found)`)
          }
        }

        // Module-level importers when name looks like a path
        if (name.includes('/') || name.includes('.')) {
          const cleanedName = name.replace(/\//g, '').replace(/\.[\w]+$/g, '')
          moduleImporters = await store.imports.getImporters(cleanedName)
          if (moduleImporters.length > 0) {
            const modLines = [
              ...new Set(moduleImporters.map((i) => i.file_path)),
            ].map((p) => `  - ${p}`)
            sections.push(
              `Module imported by (${modLines.length} file${modLines.length !== 1 ? 's' : ''}):\n${modLines.join('\n')}`,
            )
          } else {
            sections.push(`Module imported by: (none found)`)
          }
        }

        if (sections.length === 0) {
          return {
            content: [
              { type: 'text', text: `No references found for: ${name}` },
            ],
          }
        }

        const output = `References to: ${symbol!.name}\n\n${sections.join('\n\n')}`

        //usage computation
        const filePaths = new Set([
          ...allCallers.map((c) => c.callerFile),
          ...allCallers
            .map((c) => c.childFilePath)
            .filter((p): p is string => p !== null),
          ...importRefs.map((i) => i.file_path),
          ...moduleImporters.map((i) => i.file_path),
          ...inheritors.map((i) => i.file_path),
        ])
        await updateUsage(
          'find_symbol_references',
          Array.from(filePaths),
          output.length,
        )

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error finding references: ${err}` }],
          isError: true,
        }
      }
    },
  )
}
