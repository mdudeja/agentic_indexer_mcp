# Agentic Indexer MCP

A local code intelligence MCP server for agents. It builds a symbol graph from Tree-sitter and language-server signals, then exposes agent-friendly tools for finding definitions, tracing calls, estimating blast radius, locating tests, and reducing context-window waste.

_Inspired by projects like [jCodeMunch MCP](https://github.com/jgravelle/jcodemunch-mcp)._ but customized for my own workflows, codebases and preferred AI agents.

![Bun](https://img.shields.io/badge/Bun-1.0+-black?logo=bun)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue?logo=typescript)
![SQLite](https://img.shields.io/badge/SQLite-blue?logo=sqlite)
![Tree-sitter](https://img.shields.io/badge/Tree--sitter-green)
![MCP](https://img.shields.io/badge/MCP-compatible-purple)
![License](https://img.shields.io/badge/License-MIT-green)
![Experimental](https://img.shields.io/badge/Experimental-yellow)

## Current Status
![Active Development](https://img.shields.io/badge/Status-Active%20Development-blue)

### Supported Languages
- TypeScript / JavaScript / TSX
- Python

---

## What the Project Does

Agentic Indexer indexes your local codebase using native AST parsing (via [web-tree-sitter](https://github.com/tree-sitter/tree-sitter)). It extracts symbols—such as functions, classes, methods, and variables—and stores their structured metadata (signatures, docstrings, parameters, return types, and byte offsets) into a local SQLite database along with file hashes.

It then uses LSP to enhance those symbols with additional type information, interfaces/type inheritance, and call-graph links. It also features an AI-based docstring generation step to automatically document undocumented symbols using Claude, Gemini, OpenAI, or Ollama.

When an AI agent (like Claude Desktop, Cursor, Cline, or Windsurf) needs context, it can use this MCP server to query, navigate, and analyze the codebase at symbol-level resolution instead of loading thousands of lines into the context window.

---

## Installation and Usage

### Dependencies and Config
- [Bun](https://bun.sh/) (latest version)
- Language Servers for the languages you want to index (e.g., `typescript-language-server`, `based-pyright`, etc.). The language servers must be available in your system's PATH, or you can specify their absolute paths in `.agentic/config.json` file in your repo.
- Docstring Generation and Embedder need AI Providers to generate docstrings and embeddings. Currently, the following providers are supported:
  - Ollama (local LLMs)
  - OpenAI (GPT-3.5, GPT-4)
  - Claude (Anthropic)
  - Gemini (Google)
- Providers can be configured in `.agentic/config.json` with their respective API keys or local endpoints. For more information about configuring providers and other config parameters, see the [Configuration](#configuration) section below.

### Setup
- Clone the repository and install dependencies:

```bash
git clone https://github.com/mdudeja/agentic_indexer_mcp.git
cd agentic_indexer_mcp
bun install
```

- Copy `.env.template` to `.env` and fill in your API keys for the AI providers you want to use.
- Run the build command to generate an executable in the `dist` folder:

```bash
bun run build
```

- Run bun link to make the MCP server available globally:

```bash
bun link
```

- Go to your project directory and run the index command to build the initial SQLite database:

```bash
cd /path/to/your/project
agentic-indexer index [--cwd /path/to/your/project]
```

- Use the `serve` command in the config file of your preferred AI agent client (Claude Desktop, Cursor, Cline, Windsurf, etc.) to start the MCP server:

```json
{
  "mcpServers": {
    "agentic-indexer": {
      "command": "agentic-indexer",
      "args": ["serve", "--cwd", "/path/to/your/project"]
    }
  }
}
```

### Uninstallation
- To uninstall the MCP server, run:
```bash
cd /path/to/agentic_indexer_mcp
bun unlink
```
---

## Configuration

Custom configuration can be specified in `.agentic/config.json` at the root of your workspace. In a new project, you can run the `init` command to generate a default config file:

```bash
agentic-indexer init [--cwd /path/to/your/project]
```

This will create a `.agentic/config.json` file with default settings. You can then edit this file to customize the behavior of the indexer, including enabling or disabling features, specifying ignore patterns, and configuring docstring generation. If the `.env` file in repo directory of MCP server, the config file will have those as well. This way, you have a single source of truth for your API keys and other sensitive information. You can change these in the config.json file of your project if needed. Example (partial) config looks something like this -

```json
{
  "indexer": {
    "enabled": true,
    "ignore_patterns": [".git", "node_modules", "dist", "*.lock"],
    "docstring_generation": {
      "enabled": false,
      "provider": "openai",
      "write_to_file": false
    }
  }
}
```

> ⚠️ [!IMPORTANT]
> It is generally a good idea to add `.agentic` directory to your `.gitignore` file to avoid committing sensitive information, generated files, or the database.

Refer to [src/config/default_config.ts] for default settings, including supported language extensions, ignore paths, test file regexes, and entry point patterns.

---

## Architecture

The system operates across three distinct layers:

1. **Parser & Extractor Layer (Tree-Sitter):** Uses `web-tree-sitter` and compiled `.wasm` grammars to parse source files, identifying symbol kinds, imports, and call sites.
2. **Enhancement Layer (LSP):** Uses Language specific `ImportResolver` to resolve imports, and Server Protocol (LSP) to enhance symbols with additional type information, interfaces/type inheritance, and call-graph links.
3. **Database Layer (Drizzle + Bun SQLite):** Persists metadata, signatures, dependencies, and file hashes to optimize subsequent runs.

---

## MCP Server Tools

The server registers 29 specialized tools over `stdio`. They are grouped logically below:

### 1. Codebase Navigation & Search

- `list_files`: Lists all indexed files in the workspace, with optional path pattern and language filtering.
- `get_file_details`: Lists all symbols (functions, classes, variables, types, interfaces) defined in a specific file.
- `search_symbols`: Searches for symbols globally by name or wildcard pattern.
- `semantic_search_symbols`: Conceptually searches for symbols globally using natural language (via Ollama vector embeddings + RRF).
- `get_definition`: Fetches the exact source code block implementing a given symbol.
- `get_type_at_location`: Returns the fully-resolved compiler/LSP type of an identifier at a specific line and column.
- `read_file_snippet`: Reads a specific range of lines from a file.

### 2. Dependency & Call Graph Traversal

- `trace_call_graph`: Generates an indented ASCII tree of inbound (who calls X) or outbound (what X calls) call chains up to a configured depth.
- `get_blast_radius`: Finds all transitive callers (BFS) affected by modifying a symbol, helping assess refactoring risks.
- `find_symbol_references`: Returns direct call sites, named imports, and module-level importers for a symbol.
- `trace_data_flow`: Maps out the I/O boundary of a function/method (parameters, returns, caller inputs, and callee outputs).
- `trace_error_flow`: Recursively traces and lists all exceptions that can bubble up from a symbol.
- `get_required_env_vars`: Traces environment variables accessed downstream inside the call tree of a symbol.
- `get_imports_for_file`: Lists all module imports defined in a specific file.
- `get_import_by_id`: Retrieves details about a specific imported symbol or module import.

### 3. Structure & Pattern Discovery

- `get_codebase_map`: Generates a topological overview of files grouped by directory, sorting them from entry-points down to foundation layers.
- `get_entry_points`: Lists top-level exported symbols representing the public API surface.
- `explore_codebase`: Renders a comprehensive Mermaid call-graph highlighting entry-point paths, subgraphs for files/containers, and reachability.
- `find_similar_patterns`: Searches for symbols sharing a reference symbol's structural shape (matching on kind, return type, param count, or decorators).

### 4. Quality & Analytics Metrics

- `find_dead_code`: Detects unreachable code (exported unreferenced symbols and internal callables with no callers).
- `get_untested_symbols`: Lists exported symbols inside files that are not imported by any test file.
- `find_related_tests`: Locates test files exercising a specific symbol or module.
- `get_symbol_importance`: Ranks symbols using PageRank on the call graph to find critical central components.
- `get_dependency_cycles`: Detects circular import dependencies using Tarjan's SCC algorithm.
- `get_coupling_metrics`: Computes efferent/afferent coupling, instability, abstractness, and distance from the main sequence for all files.
- `get_symbol_history`: Fetches the git commit history and changes for a specific symbol using line-bound git log queries.

### 5. Auditing & Diagnostics

- `audit_agent_config`: Audits AI agent configuration rules (`.cursorrules`, `CLAUDE.md`, etc.) for stale paths and symbol references.
- `get_token_savings`: Reports context tokens saved by using MCP tools instead of loading raw source files.

---

### CLI Commands

The core commands leverage `index.ts` to manage your environment. All commands support an optional `--cwd` argument to specify the target project directory. If omitted, the current working directory is used.

1. **Index a workspace (One-off Build):**
   Run the initial parser pass on your codebase.

   ```bash
   agentic-indexer index [--cwd /path/to/your/project]
   ```
2. **Init a Workspace:**
   Create a `.agentic/config.json` file in your project root with default settings.

   ```bash
   agentic-indexer init [--cwd /path/to/your/project]
   ```

3. **Index a Single File:**
   Re-index only a specific file.

   ```bash
   agentic-indexer index-file [--cwd /path/to/your/project] --file /path/to/your/file.ts
   ```

4. **Remove Generated Docstrings:**
   Delete all generated docstrings from and database (optionally) source files.

   ```bash
   agentic-indexer remove-docstrings [--cwd /path/to/your/project]
   ```

5. **Query the Index locally:**
   Search for symbols via the CLI.

   ```bash
   agentic-indexer query [--cwd /path/to/your/project] -q "auth*" -k "function"
   ```

6. **Start the MCP Server:**
   Start the stdio MCP server for agent integration.

   ```bash
   agentic-indexer serve [--cwd /path/to/your/project]
   ```

7. **Inspect the MCP Server (while debugging, from within the cloned repo only):**
   Launch the MCP Inspector to debug tools.
   ```bash
   bun run inspect
   ```

---

### Integrating with MCP Clients

Since this server runs over standard I/O (stdio), it can easily be configured as an MCP server in your favorite AI agent client.

#### 1. Claude Desktop

Add the server definition to your Claude Desktop configuration file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "agentic-indexer": {
      "command": "agentic-indexer",
      "args": ["serve", "--cwd", "/path/to/your/project"]
    }
  }
}
```

#### 2. Cursor

To use the Agentic Indexer in Cursor:

1. Open Cursor Settings.
2. Navigate to **Features** -> **MCP**.
3. Click **+ Add New MCP Server**.
4. Fill in the following details:
   - **Name:** `agentic-indexer`
   - **Type:** `command`
   - **Command:** `agentic-indexer serve --cwd /path/to/your/project`
5. Click **Save**.

#### 3. Cline / VS Code (Roo Code, Windsurf, etc.)

If you are using VS Code extensions like Cline, Windsurf, or Roo Code, you can add it to their MCP settings configuration file (e.g., `cline_mcp_settings.json` located in your OS global app storage directory):

```json
{
  "mcpServers": {
    "agentic-indexer": {
      "command": "agentic-indexer",
      "args": ["serve", "--cwd", "/path/to/your/project"]
    }
  }
}
```

### Tips for Best Performance & Setup

1. **Pre-Indexing:** Before starting your agent, run a one-off index via `bun run index --cwd /path/to/your/project`. This builds the initial SQLite database and resolves symbols so that the MCP server is fully populated and starts immediately.
2. **Environment Variables:** If you plan on using AI docstring generation or semantic search (embedding-based), ensure your API keys (e.g. `CLAUDE_API_KEY`, `OPENAI_API_KEY`, etc.) are configured in the cloned server's `.env` file.
3. **File Watching:** When the MCP server starts, it initializes a file system watcher on the target project directory (using `chokidar`). It will automatically detect additions, modifications, and deletions, and update the SQLite symbol index incrementally in real-time.
