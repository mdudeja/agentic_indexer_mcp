# Agent Guidance: Agentic Indexer MCP

Welcome! This file provides critical context, design principles, architecture overviews, and instructions for AI agents working on or extending this repository.

---

## 🌟 Overview & Architecture

Agentic Indexer indexes codebases at a symbol level, making it easy for AI agents to locate definitions, find imports, construct call graphs, and understand type systems without blowing past context limits by loading raw source files. It registers **9 consolidated MCP tools** over `stdio` and runs incrementally by watching files using `chokidar`.

The codebase operates across the following directories:

```mermaid
graph LR
    CLI[index.ts] --> Config[src/config/]
    CLI --> DB[src/database/]
    CLI --> Server[src/server/]
    CLI --> Indexer[src/indexer/]
    CLI --> Watcher[src/watcher/]
    CLI --> AppState[src/state]
    Server --> Tools[src/server/tools/]
    Tools --> DB
    Tools --> Config
    Tools --> AppState
    Tools --> FileManager[src/indexer/FileManager.ts]
    Watcher --> Indexer[src/indexer/]
    Indexer --> Adapters[src/indexer/adapters/]
    Indexer --> Enhancers[src/indexer/enhancers/]
    Adapters --> ImportResolver[src/indexer/importResolvers/]
    Adapters --> CallSiteResolver[src/indexer/resolvers/callSiteResolvers/]
    Enhancers --> CallEdgeResolver[src/indexer/resolvers/callEdgeResolvers/]
    CallEdgeResolver --> CallEdgeBuiltins[src/constants/callEdgeBuiltins/]
    Indexer --> Embedders[src/indexer/embedders/]
    Indexer --> DB
    Indexer --> Config
    Indexer --> FileManager
    Indexer --> AppState
```

### Key Folders & Responsibilities

- [index.ts]: Main CLI entry point. Parses commands (`serve`, `index`, `enhance`, `query`, etc.).
- [src/config/]: Configuration loader, defaults, schema types.
- [src/database/]: SQLite database storage layer using Drizzle ORM and `sqlite-vec` for vector operations.
  - [IndexerDB.ts]: Singleton connection manager that initiates database connections, loads extensions, and applies migrations at startup.
  - [repositories/]: Database access layer for symbols, files, and embeddings.
- [src/indexer/]: Parser pipeline orchestration.
  - [adapters/]: Tree-sitter parsers for specific programming languages (e.g., `PythonAdapter`, `TypescriptAdapter`).
  - [enhancers/]: Type resolution, call site linkage, and structural analysis.
  - [resolvers/importResolvers/]: Resolves imports for different languages.
  - [resolvers/callSiteResolvers/]: Resolves call sites for different languages.
  - [resolvers/callEdgeResolvers/]: Resolves call edges for different languages.
  - [embedders/]: Generates embeddings for symbols using AI providers.
  - [docstrings/]: Extracts and generates (using AI providers) docstrings and comments for symbols.
  - [FileManager.ts]: Exposes `isPathIgnored`, which checks if a file path is ignored based on `.gitignore` and `indexer.ignore` rules.
- [src/server/]: MCP Server instantiation and standard IO transport logic.
  - [tools/]: Declarations and handler logic for each registered MCP tool.
- [src/watcher/]: Incrementally re-indexes files on save/change.
- [src/state/]: Maintains in-memory app state for the application.

---

## 🛠️ MCP Tool Registration

Each consolidated tool is declared in its own file in [src/server/tools/] and registered via [src/server/tools/index.ts]. Shared logic lives in [src/server/tools/helpers/].

### Adding a New Tool

1. Create a new tool file: `src/server/tools/my_new_tool.ts`.
2. Define the schema using `zod` and call `server.registerTool()` (note: the codebase uses `registerTool`, not `server.tool()`):

   ```typescript
   import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
   import { z } from 'zod'

   export function registerMyNewTool(server: McpServer) {
     server.registerTool(
       'my_new_tool',
       {
         title: 'My New Tool',
         description: 'A description of what the tool does and when to use it.',
         inputSchema: z.object({
           param: z.string().describe('A parameter description'),
         }),
       },
       async ({ param }) => {
         // Tool logic here
         return {
           content: [{ type: 'text', text: `Result: ${param}` }],
         }
       },
     )
   }
   ```

3. Register it inside [src/server/tools/index.ts].

### Consolidation Pattern

Each public tool exposes multiple **modes** (via a `mode` enum param) that absorb the capabilities of the legacy tools. When adding a capability, prefer adding a new mode to an existing tool over creating a new public tool. Record analytics via `updateUsage('public_tool_name', ...)` — always use the public tool name, not the sub-mode name.

---

## 🔌 AST Adapters & Language Support

AST extraction is done using `web-tree-sitter`. To add support for a new language:

1. **Confirm the grammar exists in `tree-sitter-wasm`.** `SupportedLanguage` is defined as `keyof QueryMap` in [node_modules/tree-sitter-wasm/index.d.ts], and `getWasmPath(lang)` (used by `TreeSitterIndexer.loadLanguage`) throws if the language isn't in that map. The grammar must be present there first; otherwise you must vendor the `.wasm` grammar and extend the package's `QueryMap`/`SupportedLanguage` type.
2. **Register the language in the config.** Add a `languages.<lang>` block in [src/config/default_config.ts] with `enabled`, `extensions`, `lsp_command`, `lang_features_paths`, and `treesitter.language_name`. `populateExtnToLangMap` in [src/config/loader.ts] derives the extension→language map from this config.
3. Write the `tags.scm` file for the language in [src/indexer/queries/{language}/tags.scm]. This defines the Tree-sitter query patterns for classes, functions, calls, imports, exports, exceptions, env variables, and docstrings, and should follow the structure of existing query files. It is loaded at runtime by `TreeSitterIndexer.loadLanguage` (which looks for `queries/${langName}/tags.scm`).
4. Create an adapter in [src/indexer/adapters/] implementing the `LanguageAdapter` interface (via `extract()`). It should map the AST node patterns for classes, functions, calls, imports, exports, exceptions, and env vars, and construct its own `ChainedImportResolver` internally (see `createImportResolver()` in `PythonAdapter`/`TypescriptAdapter`).
5. Create an import resolver implementing the `ImportResolver` interface for the language in [src/indexer/resolvers/importResolvers/] to resolve imports and re-exports (if the language supports them). TS uses `ts.sys` module resolution; Python uses a helper script + `importlib.find_spec` — use language-native resolution rather than a shared compiler.
6. Create a call site resolver implementing the `CallSiteResolver` interface for the language in [src/indexer/resolvers/callSiteResolvers/]. Call-site resolvers extract call metadata (expression, base, property, kind, location) only — linking call sites to definitions happens later in the call edge resolver.
7. Create a list of built-in functions for the language in [src/constants/callEdgeBuiltins/], consumed via `getBuiltins(languageId, callKind)` to resolve built-in call edges.
8. Create a call edge resolver inheriting from `GenericCallEdgeResolver` for the language in [src/indexer/resolvers/callEdgeResolvers/]. Override `getPartsOfCalleeExpression` and `resolveSameClassCallEdges` (passing language-specific `this`/`self` identifiers) as needed.
9. Create an enhancer inheriting from `GenericLspEnhancer` for the language in [src/indexer/enhancers/]. Every language is expected to have its own enhancer (currently only Python and TypeScript exist). `GenericLspEnhancer` was written with TypeScript in mind, so language-specific quirks belong in the language's enhancer subclass.
10. Register the pieces:
    - Add the new adapter to the `adapters` map in [src/indexer/steps/s1_symbol_extractor.ts] (keyed by language name; e.g. `tsx` reuses `TypescriptAdapter`).
    - Add the new enhancer to `loadEnhancerForFileType` in [src/indexer/IndexPipeline.ts] (a per-extension `Enhancer` cache map in `AppStateManager`).

---

## 💾 Database Schema & Migrations

We use **Drizzle ORM** with **SQLite**.

- The schemas are located in [src/database/schemas/].
- Migrations are saved under [drizzle_migrations/].
- `IndexerDB.init()` applies migrations automatically when starting.

If you modify database schemas:

1. Make your changes in the schema files.
2. Generate the migrations by running:
   ```bash
   bunx drizzle-kit generate
   ```
3. Ensure the repositories in [src/database/repositories/] are updated to reflect the schema changes.

---

## 🧪 Testing

The tests are written using Bun's native test runner (`bun test`) and are located in the [tests/](/tests/) directory.

- Running tests:
  ```bash
  bun run test
  ```
- Running linter:
  ```bash
  bun run lint
  ```

> [!WARNING]
> Before submitting changes, always run the linter and tests to make sure there are no compiler errors or broken functionality.

---

## ⚠️ Important Rules for AI Agents

1. **Path Resolution:** Always use the `resolvePath` or `resolveWorkspacePath` utility from [src/utils/paths.ts] when dealing with file/directory paths. This ensures compatibility when paths are relative to the target workspace or the indexer project home.
2. **Environment Variables:** Do not hardcode configurations. Read them from `process.env`. If a key is required, document it in `.env` and `.env.test`.
3. **Preserve Docstrings:** When editing files, maintain existing JSDoc/TSDoc headers and comments unless explicitly directed to change them.
4. **Clean Code & Modularity:** Keep MCP tool handlers slim. Keep business logic separated in repositories, adapters, or enhancers.
5. **Bun Project**: This is a Bun project. Do not use npm or yarn. Use bun instead.
6. **if not (condition) instead of nested if (condition)**: Use the early return principle unless absolutely necessary. So, instead of if (x) {something}, use if not (x) {return} then do something.
7. **Code Repetition**: Before writing any new feature or functionality, ensure that the same cannot be done by inbuilt methods of Bun or any other library used in the project, AND that you are not repeating any existing code. If you are, refactor and use the existing code.
8. **Test your code**: Always write test cases for the new feature or functionality you are adding.
