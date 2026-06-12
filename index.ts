#!/usr/bin/env bun
import { parseArgs } from 'util'
import { startMcpServer, stopMcpServer } from './src/server'
import { IndexPipeline } from './src/indexer/IndexPipeline'
import { IndexerDB } from './src/database/IndexerDB'
import type { SymbolKind } from './src/config/types'
import { logWarning } from 'src/utils/logger'
import { resolvePath } from 'src/utils/paths'
import { loadConfig } from 'src/config/loader'
import { AppStateManager } from 'src/state'

/** The module 'bun' provides a set of environment variables for configuring application settings, including logging, database access, and API keys for services like Claude, Gemini, and OpenAI. */
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
  serve               Run the MCP server (reads over stdio)
  stop                Stop the MCP server
  index               Run a one-off index of the workspace
  index-file          Index a single file (provide path via --file option)
  remove-docstrings   Remove all generated docstrings from source files and database
  query               Query the existing index from CLI

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

/** The main function serves as the entry point for executing various tasks such as serving, indexing files, querying data, or managing configurations. It processes commands and orchestrates the necessary setup and operations based on the specified command. */
async function main() {
  const config = await loadConfig(cwd)
  AppStateManager.getInstance().setItem('config', config)
  AppStateManager.getInstance().setItem('root', cwd)

  const store = IndexerDB.getInstance()
  await store.init()

  switch (command) {
    case 'serve':
      const pipeline = new IndexPipeline({
        cwd,
        store,
        includeGitIgnored: values.includeGitIgnored ?? false,
      })

      await pipeline.run()

      await startMcpServer()
      break

    case 'stop':
      await stopMcpServer()
      process.exit(0)
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

    case 'remove-docstrings': {
      const pipeline = new IndexPipeline({
        cwd,
        store,
        includeGitIgnored: true,
      })
      await pipeline.removeAllDocstrings(store)
      break
    }

    case 'query': {
      if (!values.query) {
        console.error('Error: --query is required for the query command')
        process.exit(1)
      }

      logWarning(`Searching for "${values.query}" in ${cwd}...`)
      const results = await store.symbols.search(
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

process.on('exit', async (code) => {
  logWarning(`Process exiting with code ${code}`)
  await stopMcpServer()
})

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
