# Agentic Indexer MCP

A powerful Model Context Protocol (MCP) server that provides structured, symbol-level code retrieval and codebase analysis for AI agents. Built with Bun, Tree-sitter, Drizzle ORM, and SQLite, it allows AI models to efficiently explore, search, and parse codebases without wasting context window tokens by reading entire files.

_Inspired by projects like [jCodeMunch MCP](https://github.com/jgravelle/jcodemunch-mcp)._

![Bun](https://img.shields.io/badge/Bun-1.0+-black?logo=bun)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue?logo=typescript)
![SQLite](https://img.shields.io/badge/SQLite-blue?logo=sqlite)
![Tree-sitter](https://img.shields.io/badge/Tree--sitter-green)
![MCP](https://img.shields.io/badge/MCP-compatible-purple)

---

## What the Project Does

Agentic Indexer indexes your local codebase using native AST parsing (via [web-tree-sitter](https://github.com/tree-sitter/tree-sitter)). It extracts symbols—such as functions, classes, methods, and variables—and stores their structured metadata (signatures, docstrings, parameters, return types, and byte offsets) into a local SQLite database along with file hashes.

It then uses LSP to enhance those symbols with additional type information, interfaces/type inheritance, and call-graph links. It also features an AI-based docstring generation step to automatically document undocumented symbols using Claude, Gemini, OpenAI, or Ollama.

When an AI agent (like Claude Desktop, Cursor, Cline, or Windsurf) needs context, it can use this MCP server to query, navigate, and analyze the codebase at symbol-level resolution instead of loading thousands of lines into the context window.

---

## Installation and Usage

### Dependencies and setup
- [Bun](https://bun.sh/) (latest version)
- Language Servers for the languages you want to index (e.g., `typescript-language-server`, `based-pyright`, etc.). The language servers must be available in your system's PATH, or you can specify their absolute paths in `.agentic/config.json` file in your repo.
- Docstring Generation and Embedder need AI Providers to generate docstrings and embeddings. Currently, the following providers are supported:
  - Ollama (local LLMs)
  - OpenAI (GPT-3.5, GPT-4)
  - Claude (Anthropic)
  - Gemini (Google)
- Providers can be configured in `.agentic/config.json` with their respective API keys or local endpoints. You don't need to store API keys in the json file for every repo. Those can be stored in the `.env` file in the root of the cloned repo. Similarly, for any config parameters that you want applied globally, you can change the default config in `src/config/default_config.ts` and rebuild the MCP server. Any local repo config will override the default config.


---

## Architecture

The system operates across three distinct layers:

1. **Parser & Extractor Layer (Tree-Sitter):** Uses `web-tree-sitter` and compiled `.wasm` grammars to parse source files, identifying symbol kinds, imports, and call sites.
2. **Enhancement Layer (LSP):** Uses Language Server Protocol (LSP) to enhance symbols with additional type information, interfaces/type inheritance, and call-graph links.
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

## Configuration

Custom configuration can be specified in `.agentic/config.json` at the root of your workspace:

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

Refer to [src/config/default_config.ts] for default settings, including supported language extensions, ignore paths, test file regexes, and entry point patterns.

---

## How to Use It

### Prerequisites

- [Bun](https://bun.sh/) (latest version)

### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/your-username/agentic_indexer_mcp.git
cd agentic_indexer_mcp
bun install
```

### CLI Commands

The core commands leverage `index.ts` to manage your environment:

1. **Index a workspace (One-off Build):**
   Run the initial parser pass on your codebase.

   ```bash
   bun run index --cwd /path/to/your/project
   ```

2. **Index a Single File:**
   Re-index only a specific file.

   ```bash
   bun run index-file --cwd /path/to/your/project --file /path/to/your/file.ts
   ```

3. **Remove Generated Docstrings:**
   Delete all generated docstrings from source files and database.

   ```bash
   bun run remove-docstrings --cwd /path/to/your/project
   ```

4. **Query the Index locally:**
   Search for symbols via the CLI.

   ```bash
   bun run query --cwd /path/to/your/project -q "auth*" -k "function"
   ```

5. **Start the MCP Server:**
   Start the stdio MCP server for agent integration.

   ```bash
   bun run serve --cwd /path/to/your/project
   ```

6. **Inspect the MCP Server:**
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
      "command": "bun",
      "args": [
        "run",
        "--env-file",
        "/absolute/path/to/agentic_indexer_mcp/.env",
        "/absolute/path/to/agentic_indexer_mcp/index.ts",
        "serve",
        "--cwd",
        "/absolute/path/to/your/project/to/index"
      ]
    }
  }
}
```

> [!IMPORTANT]
> Make sure to replace `/absolute/path/to/agentic_indexer_mcp` with the actual path to where you cloned this repository, and `/absolute/path/to/your/project/to/index` with the project directory you want the agent to index and analyze.
> Ensure `bun` is available globally in your path, or use the absolute path to your `bun` executable (e.g. `/usr/local/bin/bun`).

#### 2. Cursor

To use the Agentic Indexer in Cursor:

1. Open Cursor Settings.
2. Navigate to **Features** -> **MCP**.
3. Click **+ Add New MCP Server**.
4. Fill in the following details:
   - **Name:** `agentic-indexer`
   - **Type:** `command`
   - **Command:** `bun run --env-file /absolute/path/to/agentic_indexer_mcp/.env /absolute/path/to/agentic_indexer_mcp/index.ts serve --cwd /absolute/path/to/your/project/to/index`
5. Click **Save**.

#### 3. Cline / VS Code (Roo Code, Windsurf, etc.)

If you are using VS Code extensions like Cline, Windsurf, or Roo Code, you can add it to their MCP settings configuration file (e.g., `cline_mcp_settings.json` located in your OS global app storage directory):

```json
{
  "mcpServers": {
    "agentic-indexer": {
      "command": "bun",
      "args": [
        "run",
        "--env-file",
        "/absolute/path/to/agentic_indexer_mcp/.env",
        "/absolute/path/to/agentic_indexer_mcp/index.ts",
        "serve",
        "--cwd",
        "/absolute/path/to/your/project/to/index"
      ],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Tips for Best Performance & Setup

1. **Pre-Indexing:** Before starting your agent, run a one-off index via `bun run index --cwd /path/to/your/project`. This builds the initial SQLite database and resolves symbols so that the MCP server is fully populated and starts immediately.
2. **Environment Variables:** If you plan on using AI docstring generation or semantic search (embedding-based), ensure your API keys (e.g. `CLAUDE_API_KEY`, `OPENAI_API_KEY`, etc.) are configured in the cloned server's `.env` file.
3. **File Watching:** When the MCP server starts, it initializes a file system watcher on the target project directory (using `chokidar`). It will automatically detect additions, modifications, and deletions, and update the SQLite symbol index incrementally in real-time.
