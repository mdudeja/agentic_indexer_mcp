#!/usr/bin/env bun
import { parseArgs } from 'util'
import { startMcpServer } from './src/server'
import { IndexPipeline } from './src/indexer/IndexPipeline'
import { IndexerDB } from './src/database/IndexerDB'
import type { SymbolKind } from './src/config/types'
import { logWarning } from 'src/utils/logger'
import { resolvePath } from 'src/utils/paths'
import { loadConfig } from 'src/config/loader'
import { AppStateManager } from 'src/state'

/** Extends the Bun module with type definitions for environment variables covering configuration, logging, database settings, and AI service API keys. */
declare module 'bun' {
  interface Env {
    AGENTIC_DIR?: string
    CONFIG_FILENAME?: string
    NODE_ENV?: string
    LOG_LEVEL?: string
    DB_FILE_URL?: string
    DB_MIGRATIONS_DIR?: string
    CLAUDE_API_KEY?: string
    GEMINI_API_KEY?: string
    OPENAI_API_KEY?: string
  }
}

const { values, positionals } = parseArgs({
  args: Bun.argv,
  options: {
    cwd: {
      type: 'string',
    },
    query: {
      type: 'string',
      short: 'q',
    },
    kind: {
      type: 'string',
      short: 'k',
    },
    help: {
      type: 'boolean',
      short: 'h',
    },
    includeGitIgnored: {
      type: 'boolean',
      short: 'g',
    },
    file: {
      type: 'string',
    },
  },
  strict: true,
  allowPositionals: true,
})

const command = positionals[2] // e.g. bun run index.ts <command>

const cwd = resolvePath(values.cwd ?? process.cwd())

if (values.help || !command) {
  logWarning(`
Usage: agentic-indexer <command> [options]

Commands:
  serve       Run the MCP server (reads over stdio)
  index       Run a one-off index of the workspace
  index-file  Index a single file (provide path via --file option)
  query       Query the existing index from CLI

Options:
  --cwd                       Workspace directory (default: current directory)
  -q,   --query               Search query pattern (e.g. "auth*")
  -k,   --kind                Filter by symbol kind (e.g. "function")
  -h,   --help                Show this help message
  -g,  --include-gitignored  Include files ignored by .gitignore (default: false)
  --file                      Path to a single file to index (required for index-file command)
  `)
  process.exit(values.help ? 0 : 1)
}

/** Initializes application configuration and state, opens the database, and executes the specified command to either start the server, index files, or query symbols. */
async function main() {
  const config = await loadConfig(cwd)
  AppStateManager.getInstance().setItem('config', config)
  AppStateManager.getInstance().setItem('root', cwd)

  const store = IndexerDB.getInstance()
  await store.init()

  switch (command) {
    case 'serve':
      await startMcpServer()
      break

    case 'index': {
      logWarning(`Running index on ${cwd}`)
      const pipeline = new IndexPipeline({
        cwd,
        store,
        includeGitIgnored: values.includeGitIgnored ?? false,
      })

      await pipeline.run()
      break
    }

    case 'index-file': {
      if (!values.file) {
        console.error('Error: --file is required for the index-file command')
        process.exit(1)
      }

      const absPath = resolvePath(values.file)
      logWarning(`Indexing single file: ${absPath}`)
      const pipeline = new IndexPipeline({
        cwd,
        store,
        includeGitIgnored: true, // For single file indexing, we should include it even if it's gitignored
      })

      await pipeline.runOnFile(absPath)
      break
    }

    case 'query': {
      if (!values.query) {
        console.error('Error: --query is required for the query command')
        process.exit(1)
      }

      logWarning(`Searching for "${values.query}" in ${cwd}...`)
      const results = await store.searchSymbols(
        values.query,
        values.kind as SymbolKind | 'all',
        undefined,
        50,
      )

      if (results.length === 0) {
        logWarning('No results found.')
      } else {
        logWarning(`Found ${results.length} results:\n`)
        for (const r of results) {
          logWarning(`[${r.kind.toUpperCase()}] ${r.name}`)
          logWarning(`  File: ${r.file_path}:${r.line + 1}`)
          if (r.signature) logWarning(`  Signature: ${r.signature}`)
        }
      }
      break
    }
    default:
      console.error(`Unknown command: ${command}`)
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
