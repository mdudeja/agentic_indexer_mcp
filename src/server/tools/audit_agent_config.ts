import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { AppStateManager } from 'src/state'
import { join } from 'node:path'
import { resolvePath } from 'src/utils/paths'

/**
 * Extract file-path-like tokens from content.
 * Matches strings that look like relative paths with an extension, e.g. src/utils/foo.ts
 */
function extractPathRefs(content: string): string[] {
  const seen = new Set<string>()
  const results: string[] = []
  // Match word/slash sequences that contain a dot-extension and at least one slash
  const re =
    /(?:^|[\s`'"(])([a-zA-Z][\w./\-]*\/[\w./\-]+\.\w{1,6})(?:$|[\s`'")\]:,])/gm
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
        'Scan AI agent/assistant context files (.cursorrules, CLAUDE.md, AGENTS.md, copilot-instructions.md, etc.) for stale references that may be wasting tokens or misleading the AI:\n' +
        '  • Stale file paths — path-like references that no longer exist in the indexed file set\n' +
        '  • Stale symbol refs — backtick-wrapped identifiers no longer present in the symbol index\n' +
        '  • Token estimate — crude char/4 estimate to spot bloated files\n\n' +
        'Run after renaming files or symbols to catch outdated agent instructions.',
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
        const allFiles = await store.getAllFiles()
        const filePathSet = new Set(allFiles.map((f) => f.path))

        const allSymbols = await store.getAllSymbols()
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

        return {
          content: [{ type: 'text', text: results.join('\n') }],
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
