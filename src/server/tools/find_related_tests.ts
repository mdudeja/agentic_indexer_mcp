import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'

const TEST_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$|__tests__\//

/** Registers a tool to find test files that exercise a given symbol or file. */
export function registerFindRelatedTestsTool(server: McpServer) {
  server.registerTool(
    'find_related_tests',
    {
      title: 'Find Related Tests',
      description:
        'Find all test files that exercise a given symbol or module. Pass a file path to find tests importing that module, or a bare symbol name to find tests that call it. Tests encode intended behavior more reliably than documentation.',
      inputSchema: z.object({
        target: z
          .string()
          .describe(
            'Symbol name (e.g. validateInput) or file path (e.g. src/utils/validate.ts) to find tests for.',
          ),
      }),
    },
    async ({ target }) => {
      const store = IndexerDB.getInstance()
      try {
        const name = target as string

        const allFiles = await store.getAllFiles()
        const testFilePaths = new Set(
          allFiles.filter((f) => TEST_RE.test(f.path)).map((f) => f.path),
        )

        if (testFilePaths.size === 0) {
          return {
            content: [{ type: 'text', text: 'No test files found in the indexed workspace.' }],
          }
        }

        const found = new Map<string, string[]>() // testFile → [reason]

        // Module importers (when target looks like a file path)
        if (name.includes('/') || name.endsWith('.ts') || name.endsWith('.tsx')) {
          const importers = await store.getImporters(name)
          for (const imp of importers) {
            if (testFilePaths.has(imp.file_path)) {
              const reasons = found.get(imp.file_path) ?? []
              reasons.push(`imports module '${name}'`)
              found.set(imp.file_path, reasons)
            }
          }
        }

        // Call-level references (when target looks like a symbol name)
        if (!name.includes('/')) {
          const callers = await store.getCallers(name)
          for (const c of callers) {
            if (testFilePaths.has(c.callerFile)) {
              const reasons = found.get(c.callerFile) ?? []
              reasons.push(`calls ${name} via ${c.callerName} (line ${c.line + 1})`)
              found.set(c.callerFile, reasons)
            }
          }

          // Also try as imported name
          const importRefs = await store.getImportsByName(name)
          for (const imp of importRefs) {
            if (testFilePaths.has(imp.file_path)) {
              const reasons = found.get(imp.file_path) ?? []
              reasons.push(`imports '${name}' by name`)
              found.set(imp.file_path, reasons)
            }
          }
        }

        if (found.size === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No test files found referencing '${name}'.\n(${testFilePaths.size} test files exist in the index — target may not be directly exercised by tests.)`,
              },
            ],
          }
        }

        const lines = [...found.entries()].map(([file, reasons]) => {
          return `  - ${file}\n${reasons.map((r) => `      • ${r}`).join('\n')}`
        })

        return {
          content: [
            {
              type: 'text',
              text: `Related tests for: ${name}\n\nFound ${found.size} test file${found.size !== 1 ? 's' : ''}:\n${lines.join('\n')}`,
            },
          ],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error finding related tests: ${err}` }],
          isError: true,
        }
      }
    },
  )
}
