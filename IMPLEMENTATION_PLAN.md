# Implementation Plan: agentic_indexer_mcp — Robust Contextual Indexing

## Context

The indexer currently captures only file-local symbol data. `get_file_summary` returns a flat name list with no import or importer context. `get_definition` returns raw source with no parent class, caller, or usage context. Three tools crash at runtime. The goal is to make every tool response give an AI agent a complete picture of a file or symbol's role in the project — so it never needs to read a raw file.

---

## Step 1 — Fix the three runtime bugs

**Must land first. Nothing else works without these.**

### 1a. Property name mismatch in `get_definition.ts`
**File:** `src/server/tools/get_definition.ts`

`symbol.filePath` → `symbol.file_path` (and `symbol.endLine` → `symbol.end_line`) on lines 57–74.

### 1b. `Watcher.ts` never calls `db.init()`
**File:** `src/indexer/Watcher.ts`

Make `start()` async. After `IndexerDB.getInstance()`, add `await db.init()`.
**File:** `src/server/index.ts` — update the `watcher.start()` call accordingly.

### 1c. Stub `getCallers()` to unblock `get_blast_radius`
**File:** `src/database/IndexerDB.ts`

Add `async getCallers(symbolName: string)` returning `[]` for now. Real implementation in Step 5.

**Test after Step 1:** Index a project, call all 7 tools — no crashes.

---

## Step 2 — Stable symbol IDs

**Must come before Step 5 (call edges reference symbol IDs). A re-index is required after this.**

**File:** `src/indexer/steps/symbol_extractor.ts`

Replace `randomUUID()` with a deterministic hash using `Bun.CryptoHasher`:
```
symbol_id = sha256(file_path + ':' + name + ':' + kind + ':' + startRow)
import_id = sha256(file_path + ':import:' + moduleName + ':' + (importedName ?? ''))
```

**Effect:** IDs survive re-indexing, so `parent_id` links don't break. Clear the DB and re-index once after this change.

**Test:** Index the same codebase twice without changes — `SELECT id, name FROM symbols ORDER BY id` must be identical both runs.

---

## Step 3 — Named import extraction

**Required by Steps 7, 8, 10 (all contextual tool enrichment).**

**File:** `src/indexer/steps/symbol_extractor.ts`

In the `import_statement` branch of `traverse()`, walk `import_clause` children to emit one row per named binding instead of one row per import statement:

- `identifier` child of `import_clause` → default import → `imported_name = identifierText`
- `namespace_import` child → `imported_name = '* as ' + aliasText'`
- `named_imports` child → walk `import_specifier` nodes → `imported_name = alias ?? name` per specifier
- No `import_clause` (side-effect import) → `imported_name = null`

**File:** `src/database/schemas/imports.schema.ts`

Add index on `imported_name`:
```typescript
index('idx_imports_imported_name').on(table.imported_name)
```

Run `bunx drizzle-kit generate` → migration #1.

**Test:** Index a file with `import { readFile, writeFile } from 'fs'`. Expect two rows in `imports` with `imported_name = 'readFile'` and `'writeFile'`.

---

## Step 4 — `parameters` and `return_type` columns on symbols

**Required by Step 8 (structured `get_definition` output). Comes before call graph to batch migrations.**

### 4a. Schema change
**File:** `src/database/schemas/symbols.schema.ts`

Add after `signature`:
```typescript
parameters: text(),
return_type: text(),
```

Run `bunx drizzle-kit generate` → migration #2 (`ALTER TABLE symbols ADD COLUMN parameters TEXT; ADD COLUMN return_type TEXT`).

### 4b. Extraction
**File:** `src/indexer/steps/symbol_extractor.ts`

For nodes with `nodeInfo.parameters_field` (function_declaration, method_definition, arrow_function):
```typescript
const parametersNode = node.childForFieldName(nodeInfo.parameters_field)
const parameters = parametersNode?.text ?? null
const returnTypeNode = nodeInfo.return_type_field 
  ? node.childForFieldName(nodeInfo.return_type_field) : null
const return_type = returnTypeNode?.text ?? null
```

Pass into `addSymbol()`. The `upsertSymbols` prepared statement auto-includes new columns via `getColumns()`.

**Test:** Index a file with `function add(a: number, b: number): number {}`. Expect `parameters = '(a: number, b: number)'`, `return_type = ': number'`.

---

## Step 5 — Call graph extraction + `call_edges` table

**Most complex step. Unblocks `get_blast_radius`, enriched `get_definition`, and `find_usages`.**

### 5a. New schema
**New file:** `src/database/schemas/call_edges.schema.ts`
```typescript
export const call_edges = sqliteTable('call_edges', {
  id: text().primaryKey(),
  caller_symbol_id: text().notNull(),
  caller_file: text().notNull(),
  callee_name: text().notNull(),
  callee_file: text(),          // null until resolution pass
  callee_symbol_id: text(),     // null until resolution pass
}, table => [
  index('idx_call_edges_caller').on(table.caller_symbol_id),
  index('idx_call_edges_callee_name').on(table.callee_name),
  index('idx_call_edges_callee_symbol').on(table.callee_symbol_id),
])
```

Export from `src/database/schemas/index.ts`. Run `bunx drizzle-kit generate` → migration #3.

### 5b. Extraction in `symbol_extractor.ts`
Add a `callEdges: RawCallEdge[]` accumulator (same pattern as `symbols` and `imports`).

Extend `traverse()` with a `currentCallableId?: string` parameter. When descending into a callable node (types in `config.lists.callable_nodes`): set `currentCallableId` to the new symbol's ID.

Within callable scope, detect `call_expression` nodes:
- Get callee name from `node.childForFieldName('function')`:
  - `identifier` → take `.text` directly
  - `member_expression` → take `.childForFieldName('property').text`
  - Anything else → skip (too complex to extract reliably)
- Emit a `RawCallEdge` with stable ID: `sha256(caller_symbol_id + ':calls:' + callee_name + ':' + startRow)`

Return `{ symbols, imports, callEdges }` from `extractSymbols()`.

**Edge cases:**
- **Recursive calls:** Valid — caller_symbol_id == callee_symbol_id (resolved later). Do not filter.
- **Module-level calls** (no callable scope): `currentCallableId` is undefined — skip.
- **Nested callables** (function inside function): the inner callable sets its own `currentCallableId` for its children.

### 5c. Thread `callEdges` through the pipeline
**File:** `src/indexer/TreeSitterIndexer.ts` — update `parse()` return type to include `callEdges`.  
**File:** `src/indexer/IndexPipeline.ts` — after `upsertImports`, add `await store.upsertCallEdges(parsed.callEdges)`.

### 5d. DB methods in `IndexerDB.ts`
Add prepared statements for `call_edges` (delete-by-caller_file then batch insert — same pattern as symbols).

```typescript
async upsertCallEdges(edges: CallEdge['Insert'][])
async getCallers(symbolName: string)   // replace the stub from Step 1c
async getCallees(symbolId: string)
```

Add `await this.db.delete(schema.call_edges)` to `clear()`.

### 5e. Fix `get_blast_radius.ts`
Now that `getCallers()` is real, display `caller_file` grouped, with note to use `get_definition` on the `caller_symbol_id`.

**Test:** Index a project where `funcA` calls `funcB`. Query `SELECT * FROM call_edges LIMIT 10` — expect rows. `get_blast_radius('funcB')` should list `funcA`'s file.

---

## Step 6 — Symbol resolution pass

**Turns call_edge `callee_name` strings into cross-file typed pointers. Runs at end of `IndexPipeline.run()`.**

### 6a. Path resolver helper
**File:** `src/utils/paths.ts`

Add `resolveImportPath(fromFile: string, moduleName: string, cwd: string, indexedFiles: Set<string>): string | null`:
- Only handles relative imports (starting with `.` or `..`)
- Tries suffixes: `''`, `'.ts'`, `'.tsx'`, `'.js'`, `'.jsx'`, `'/index.ts'`, etc.
- Returns the first candidate present in `indexedFiles`; null for package imports

### 6b. Resolution method in `IndexerDB.ts`
Add `async resolveCallEdges(cwd: string)`:

1. SELECT all unresolved call_edges (where `callee_symbol_id IS NULL`)
2. For each unique `caller_file`, query its imports (relative only)
3. Resolve each import path using `resolveImportPath()`
4. Query `symbols` for matching `callee_name` that is `exported = 1` in that resolved file
5. UPDATE call_edges SET `callee_file`, `callee_symbol_id` where matched

**Edge cases:**
- Circular imports: safe — iterates DB rows once, no recursive graph walk
- Ambiguous name (same name exported from two different imported files): take first match; log a warning
- Package imports (non-relative): skip, leave `callee_file = null`

### 6c. Wire into pipeline
**File:** `src/indexer/IndexPipeline.ts`

After all file upserts in `run()`, add:
```typescript
await this.options.store.resolveCallEdges(this.options.cwd)
```

For `runOnFile()` (watch mode): call a targeted `resolveCallEdgesForFile(file, cwd)` variant, or call the full resolution pass (acceptable overhead).

**Test:** In a project where `a.ts` imports `{ doThing }` from `./b` and calls `doThing()`, after indexing: `SELECT callee_file, callee_symbol_id FROM call_edges WHERE callee_name = 'doThing'` should be non-null.

---

## Step 7 — Enrich `get_file_summary` tool response

**Requires Steps 2 (stable IDs for hierarchy), 3 (named imports).**

### 7a. New DB methods in `IndexerDB.ts`
```typescript
async getFileImports(filePath: string)   // SELECT from imports WHERE file_path = ?
async getImportedBy(filePath: string)    // heuristic LIKE query on module_name using file stem
```

The `getImportedBy` heuristic: extract the file's stem (e.g. `service` from `src/auth/service.ts`), query `WHERE module_name LIKE '%service%'`. Acknowledge false-positive risk in tool description.

### 7b. Rewrite `get_file_summary.ts` output

Replace flat grouped list with:

```
Summary for src/auth/service.ts:

## IMPORTS
  'bcrypt': { hash, compare }
  './types': { User, AuthResult }
  'path': (default)

## IMPORTED BY (approximate)
  src/server/routes.ts
  src/app.ts

## SYMBOLS
CLASS AuthService [exported]
  PROPERTY db (line 8)
  METHOD constructor (line 10)
  METHOD login (line 12) [exported]
  METHOD logout (line 28)
FUNCTION hashPassword (line 45) [exported]
TYPE AuthConfig (line 3)
```

Build the tree using `buildHierarchy()` from `hierarchy_generator.ts` (already exists). Walk `roots` recursively with indent. Group `imports` by `module_name`, collecting all `imported_name` values.

**Test:** Call `get_file_summary` on a file with a class. Verify nested methods appear under the class and imports section is populated.

---

## Step 8 — Enrich `get_definition` tool response

**Requires Steps 2, 3, 5.**

### 8a. New DB methods in `IndexerDB.ts`
```typescript
async getSiblingSymbols(parentId: string, excludeId: string)  // other members of same parent
async getNamedImporters(symbolName: string, symbolFile: string)  // files importing this symbol by name
```

`getNamedImporters` joins on `imported_name = symbolName` AND `module_name LIKE '%stem%'` where stem is the file's basename.

### 8b. Rewrite `get_definition.ts`

After the bug fix from Step 1a, add contextual sections:

1. **Source block** (existing, now working)
2. **Parameters / return type** — from `symbol.parameters`, `symbol.return_type` (Step 4)
3. **Class context** — if `symbol.parent_id` is non-null: fetch parent, fetch siblings, render `Class context: AuthService\n  Other members: login (line 12), logout (line 28)`
4. **Imported by** — if `symbol.exported`: call `getNamedImporters()`
5. **Called by** — call `getCallers(symbol.name)` (Step 5d)

Output format (plain text):
```
Definition of AuthService.login in src/auth/service.ts:

```typescript
async login(user: string, pass: string): Promise<AuthResult> { ... }
```

Parameters: (user: string, pass: string)
Return type: Promise<AuthResult>

Class context: AuthService (src/auth/service.ts:5)
  Other members: constructor (line 10), logout (line 28), db (line 8)

Imported by:
  src/server/routes.ts
  src/app.ts

Called by:
  handleLogin in src/handlers/auth.ts
```

**Test:** Call `get_definition` for a method in a class. Verify class context section. Call it for an exported symbol imported somewhere — verify "Imported by".

---

## Step 9 — Decorator extraction

**Simple, no dependencies on earlier steps beyond existing infrastructure.**

**File:** `src/indexer/steps/symbol_extractor.ts`

In `addSymbol()`, before constructing the symbol object, walk `node.previousNamedSibling` backwards while `sibling.type === 'decorator'`. Collect and join as the `decorator` field.

The `decorator` column already exists — no migration needed.

**Test:** Index a file with `@Injectable() class MyService {}`. `SELECT decorator FROM symbols WHERE name = 'MyService'` → `'@Injectable()'`.

---

## Step 10 — `find_usages` tool (new)

**Requires Steps 3 and 5.**

### 10a. DB method
**File:** `src/database/IndexerDB.ts`

```typescript
async findUsages(symbolName: string, symbolFile?: string): Promise<{
  importedIn: { file_path: string; module_name: string }[]
  calledBy: { caller_file: string; caller_symbol_id: string }[]
}>
```

Runs two queries in parallel: `imports WHERE imported_name = symbolName` and `call_edges WHERE callee_name = symbolName`.

### 10b. New tool file
**New file:** `src/server/tools/find_usages.ts`

Schema: `{ symbol_name: z.string(), symbol_file: z.string().optional() }`

Renders:
```
Usages of UserService:

Imported in:
  src/routes/auth.ts  (from './services/user')
  src/app.ts          (from './services/user')

Called by:
  createUser in src/controllers/user.ts
```

**File:** `src/server/tools/index.ts` — register the new tool.

**Test:** Index a project where `UserService` is imported in 2 files and called in 1. `find_usages('UserService')` returns all 3 sites.

---

## Step 11 — Real `plan_refactoring`

**Requires Step 10.**

**File:** `src/server/tools/plan_refactoring.ts`

Replace hardcoded template with data-driven checklist using `store.findUsages()`:
- `rename`: list every named import site (must update import stmt) + every call site (flag for review)
- `move`: list every module-level importer (must update import path) + call sites
- `extract`: list call sites only

Output is a numbered checklist with file+line references from actual index data.

---

## Migration File Sequence

| Migration | Triggered by | Content |
|---|---|---|
| #1 | Step 3 | `CREATE INDEX idx_imports_imported_name` |
| #2 | Step 4a | `ALTER TABLE symbols ADD COLUMN parameters TEXT; ADD COLUMN return_type TEXT` |
| #3 | Step 5a | `CREATE TABLE call_edges (...)` |

Run `bunx drizzle-kit generate` after each schema change. Existing migration runner in `IndexerDB.init()` applies them in order automatically.

---

## Critical Files Modified

| File | Steps |
|---|---|
| `src/server/tools/get_definition.ts` | 1a, 8b |
| `src/indexer/Watcher.ts` | 1b |
| `src/server/index.ts` | 1b |
| `src/database/IndexerDB.ts` | 1c, 5d, 6b, 7a, 8a, 10a |
| `src/indexer/steps/symbol_extractor.ts` | 2, 3, 4b, 5b, 9 |
| `src/database/schemas/imports.schema.ts` | 3 |
| `src/database/schemas/symbols.schema.ts` | 4a |
| `src/database/schemas/call_edges.schema.ts` | 5a (new file) |
| `src/database/schemas/index.ts` | 5a |
| `src/indexer/TreeSitterIndexer.ts` | 5c |
| `src/indexer/IndexPipeline.ts` | 5c, 5e, 6c |
| `src/server/tools/get_blast_radius.ts` | 5e |
| `src/utils/paths.ts` | 6a |
| `src/server/tools/get_file_summary.ts` | 7b |
| `src/server/tools/find_usages.ts` | 10b (new file) |
| `src/server/tools/index.ts` | 10c |
| `src/server/tools/plan_refactoring.ts` | 11 |

---

## Verification

**After each step, test with:**
```bash
bun run index.ts index --cwd <test-project-path>
bun run index.ts query -q '*' -k function
```

**Full end-to-end after Step 11:**
1. Start server: `bun run index.ts start --cwd <test-project-path>`
2. Call `get_file_summary` on a file with a class — expect tree structure + imports section + importers section
3. Call `get_definition` on a method — expect class context, siblings, callers, importers
4. Call `find_usages` on an exported symbol — expect import sites + call sites
5. Call `get_blast_radius` on a frequently-called function — expect non-empty caller list
6. Modify a tracked file, verify watcher re-indexes without crash
