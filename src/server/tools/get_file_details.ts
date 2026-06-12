import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { updateUsage } from 'src/utils/updateUsage'

/** Registers a tool to retrieve all symbols defined in a file, with optional filtering to exported/public symbols only. */
export function registerGetFileDetailsTool(server: McpServer) {
  server.registerTool(
    'get_file_details',
    {
      title: 'Get File Details',
      description:
        'List all symbols defined in a specific file — functions, classes, methods, constants, types, and interfaces — ' +
        'grouped by kind with signatures, parameters, return types, and docstrings. ' +
        '\n\n' +
        'WHEN TO USE: When you know the file but not which symbol you need yet. ' +
        "This gives you a map of the file's contents so you can then call `get_definition` on a specific symbol. " +
        'It is more targeted than `search_symbols` (which searches by name across all files). ' +
        '\n\n' +
        'PARAMETER GUIDANCE: ' +
        '`include_private=false` — show only exported symbols and public members of exported types. ' +
        'Use this when you only care about what callers can see (the public contract). ' +
        '`include_lexical_declarations=true` — also include non-exported constants, variables, and type aliases. ' +
        'Use this when you need a complete picture of module-level state and types. ' +
        '\n\n' +
        'OUTPUT FORMAT: Header with file path and exported/total symbol count, ' +
        'then one `## KIND` section per symbol kind, each symbol showing name, line, exported flag, signature, params, return type, and docstring. ' +
        '\n\n' +
        'Supports partial file name or path matching — if multiple files match, the tool asks you to be more specific.',
      inputSchema: z.object({
        file_path_or_file_name: z
          .string()
          .describe(
            'File name or File path relative to workspace root. Supports partial file name or file path matches.',
          ),
        include_private: z
          .boolean()
          .default(true)
          .describe(
            'When false, returns only exported symbols and public members of exported types. Default true returns all symbols.',
          ),
        include_lexical_declarations: z
          .boolean()
          .default(false)
          .describe(
            'When true, includes symbols like constants, variables, and type aliases that are not exported but are still important for understanding the file contents. Default false focuses on functions, methods and classes.',
          ),
      }),
    },
    async ({
      file_path_or_file_name,
      include_private,
      include_lexical_declarations,
    }) => {
      const store = IndexerDB.getInstance()
      try {
        const files = await store.files.getByPartialNameOrPath(
          file_path_or_file_name,
        )
        if (files.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No file found matching: ${file_path_or_file_name}`,
              },
            ],
          }
        }

        if (files.length > 1) {
          const fileList = files.map((f) => `  - ${f.path}`).join('\n')
          return {
            content: [
              {
                type: 'text',
                text: `Multiple files found matching "${file_path_or_file_name}". Please specify a more specific path or use the file ID:\n${fileList}`,
              },
            ],
          }
        }

        const fileRecord = files[0]

        const allSymbols = await store.symbols.getForFile(fileRecord!.path)

        if (allSymbols.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No symbols found or file not indexed: ${file_path_or_file_name}`,
              },
            ],
          }
        }

        let symbols = allSymbols

        if (!include_private) {
          const parentMap = new Map(allSymbols.map((s) => [s.id, s]))

          symbols = allSymbols.filter((sym) => {
            if (sym.exported) return true
            if (sym.parent_id) {
              const parent = parentMap.get(sym.parent_id)
              if (
                parent?.exported &&
                !sym.signature?.trimStart().startsWith('private ')
              ) {
                return true
              }
            }
            return false
          })
        }

        if (!include_lexical_declarations) {
          symbols = symbols.filter((s) => {
            if (
              s.kind === 'const' ||
              s.kind === 'let' ||
              s.kind === 'var' ||
              s.kind === 'type' ||
              s.kind === 'interface'
            ) {
              return s.exported
            }
            return true
          })
        }

        const totalCount = allSymbols.length
        const exportedCount = allSymbols.filter((s) => s.exported).length

        // Group by kind
        const byKind = new Map<string, typeof symbols>()
        for (const sym of symbols) {
          const group = byKind.get(sym.kind) ?? []
          group.push(sym)
          byKind.set(sym.kind, group)
        }

        const sections: string[] = []
        for (const [kind, syms] of byKind) {
          const lines = syms.map((s) => {
            let line = `  - ${s.name} (line ${s.line + 1})`
            let params, return_type
            try {
              params = s.parameters_json ? JSON.parse(s.parameters_json) : null
              return_type = s.return_type ? s.return_type : null
            } catch (e) {
              // Ignore JSON parsing errors
            }

            if (s.exported) line += ' [exported]'
            if (s.signature && (!params || params.length === 0)) {
              line += `\n    Signature: ${s.signature}`
            }
            if (s.docstring) line += `\n    Doc: ${s.docstring.split('\n')[0]}`
            if (params && params.length > 0) {
              line += `\n    Parameters: ${params
                .map((p: any) => `${p.name}: ${p.type}`)
                .join(', ')}`
            }
            if (return_type) {
              line += `\n    Returns: ${return_type}`
            }
            return line
          })
          sections.push(`## ${kind.toUpperCase()}\n${lines.join('\n')}`)
        }

        const header = `File: ${fileRecord!.path}\nExported: ${exportedCount} / Total: ${totalCount}${!include_private ? ' (showing public interface only)' : ''}\n`
        const content = header + '\n' + sections.join('\n\n')

        // usage computation
        const filePaths = new Set(files.map((f) => f.path))
        await updateUsage(
          'get_file_details',
          Array.from(filePaths),
          content.length,
        )

        return {
          content: [{ type: 'text', text: content }],
        }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Error getting file details: ${err}` },
          ],
          isError: true,
        }
      }
    },
  )
}
