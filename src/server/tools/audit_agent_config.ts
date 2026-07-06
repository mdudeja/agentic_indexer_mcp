import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { AppStateManager } from 'src/state'
import { join } from 'node:path'
import { resolvePath } from 'src/utils/paths'
import { updateUsage } from 'src/utils/updateUsage'

/**
 * Extract file-path-like tokens from content.
 * Matches strings that look like relative paths with or without an extension,
 * e.g. src/utils/foo.ts or src/utils
 */
function extractPathRefs(content: string): string[] {
  const seen = new Set<string>()
  const results: string[] = []
  // Match word/slash sequences that look like paths, optionally ending with a dot and 1-6 letter extension
  const re =
    /(?:^|[\s`'"(])([a-zA-Z][\w./\-]*\/[\w./\-]+(\.\w{1,6})?)(?:$|[\s`'")\]:,])/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const ref = m[1]!.trim()
    if (!seen.has(ref)) {
      seen.add(ref)
      results.push(ref)
    }
  }
  return results
}

/**
 * Extract backtick-wrapped identifiers from content — these are the most reliable
 * symbol references in agent config files.
 */
function extractSymbolRefs(content: string): string[] {
  const seen = new Set<string>()
  const results: string[] = []
  const re = /`([A-Za-z_$][\w$]*)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const ref = m[1]!
    // Filter out very short tokens and common markdown keywords
    if (ref.length < 3) continue
    if (!seen.has(ref)) {
      seen.add(ref)
      results.push(ref)
    }
  }
  return results
}

/** Registers a tool to audit AI agent configuration files for stale paths and symbol references. */
export function registerAuditAgentConfigTool(server: McpServer) {
  server.registerTool(
    'audit_agent_config',
    {
      title: 'Audit Agent Config',
      description:
        'Scan AI agent context files (.cursorrules, CLAUDE.md, AGENTS.md, copilot-instructions.md, etc.) for stale references ' +
        'that waste tokens or silently mislead agents with wrong information. ' +
        '\n\n' +
        'WHAT IT CHECKS: ' +
        '(1) Stale file paths — path-like strings that no longer exist in the indexed file set (renamed, deleted, or moved). ' +
        '(2) Stale symbol refs — backtick-wrapped identifiers (e.g. `MyClass`) that are no longer in the symbol index. ' +
        '(3) Token estimate — crude char/4 approximation per file to spot unusually large context files. ' +
        '\n\n' +
        'WHEN TO RUN: After any rename, delete, or restructure of files or symbols. Run proactively if the index has changed significantly and agent behavior seems degraded. ' +
        '\n\n' +
        'OUTPUT FORMAT: One block per config file found, listing stale paths and stale symbol names with ✗ markers. ' +
        'Files with no stale references print ✓. ' +
        '\n\n' +
        'LIMITATIONS: Path detection uses a heuristic regex (path-like strings with a slash and file extension). ' +
        'Symbol detection only catches backtick-wrapped identifiers — inline prose mentions of symbol names are not detected. ' +
        'Update the stale references manually or regenerate the config file to fix the issues.',
      inputSchema: z.object({
        project_root: z
          .string()
          .optional()
          .describe(
            'Absolute path to the project root. Defaults to the root used during indexing.',
          ),
      }),
    },
    async ({ project_root }) => {
      const AGENT_CONFIG_CANDIDATES =
        AppStateManager.getInstance().getItem('config')
          ?.agent_config_candidates ?? []

      const store = IndexerDB.getInstance()
      try {
        const root =
          (project_root as string | undefined) ??
          AppStateManager.getInstance().getItem('root') ??
          process.cwd()

        // Load indexed paths and symbol names for reference lookup
        const allFiles = await store.files.getAll()
        const filePathSet = new Set(allFiles.map((f) => f.path))

        const allSymbols = await store.symbols.getAll()
        const symbolNameSet = new Set(allSymbols.map((s) => s.name))

        const results: string[] = []
        let foundAny = false

        for (const candidate of AGENT_CONFIG_CANDIDATES) {
          const fullPath = join(root, candidate)
          const bunFile = Bun.file(fullPath)
          const exists = await bunFile.exists()
          if (!exists) continue

          foundAny = true
          const content = await bunFile.text()
          const tokenEstimate = Math.ceil(content.length / 4)

          const pathRefs = extractPathRefs(content)
          const stalePaths = pathRefs.filter((p) => {
            const normalized = resolvePath(p)
            return !filePathSet.has(normalized) && !filePathSet.has(p)
          })

          const symbolRefs = extractSymbolRefs(content)
          const staleSymbols = symbolRefs.filter((s) => !symbolNameSet.has(s))

          results.push(`── ${candidate} (~${tokenEstimate} tokens) ──`)

          if (stalePaths.length === 0 && staleSymbols.length === 0) {
            results.push('  ✓ No stale references detected.')
          } else {
            if (stalePaths.length > 0) {
              results.push(`  Stale paths (${stalePaths.length}):`)
              for (const p of stalePaths) results.push(`    ✗ ${p}`)
            }
            if (staleSymbols.length > 0) {
              results.push(`  Stale symbols (${staleSymbols.length}):`)
              for (const s of staleSymbols) results.push(`    ✗ \`${s}\``)
            }
          }
          results.push('')
        }

        if (!foundAny) {
          return {
            content: [
              {
                type: 'text',
                text: `No agent config files found in ${root}.\nLooked for: ${AGENT_CONFIG_CANDIDATES.join(', ')}`,
              },
            ],
          }
        }

        results.unshift(
          `Agent config audit for ${root}`,
          `Index contains ${allFiles.length} files and ${allSymbols.length} symbols.\n`,
        )

        const output = results.join('\n')

        // Analytics computation
        updateUsage('audit_agent_config', [], output.length)

        return {
          content: [{ type: 'text', text: output }],
        }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Error auditing agent config: ${err}` },
          ],
          isError: true,
        }
      }
    },
  )
}
