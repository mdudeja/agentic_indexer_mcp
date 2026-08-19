import type { IndexerDB } from 'src/database/IndexerDB'
import type { IndexedSymbol } from 'src/database/schemas/symbols.schema'
import type { IndexedFile } from 'src/database/schemas'

export type SymbolLookupResult =
  | { ok: true; symbol: IndexedSymbol['Select'] }
  | { ok: false; error: string }

/**
 * Resolves a symbol from either a `symbol_id` or a `name` + `file_path_or_name`
 * combination. Mirrors the disambiguation logic used by the legacy get_definition
 * and get_symbol_history tools.
 */
export async function resolveSymbol(
  store: IndexerDB,
  opts: {
    symbol_id?: string
    name?: string
    file_path_or_name?: string
  },
): Promise<SymbolLookupResult> {
  const { symbol_id, name, file_path_or_name } = opts

  if (symbol_id) {
    const symbol = await store.symbols.getDefinition(symbol_id)
    if (!symbol) {
      return { ok: false, error: `Symbol with id '${symbol_id}' not found.` }
    }
    return { ok: true, symbol }
  }

  if (name && file_path_or_name) {
    const fileResolution = await resolveFile(store, opts.file_path_or_name!)

    if (!fileResolution.ok) {
      return fileResolution
    }

    const symbol = await store.symbols.getDefinitionByName(
      name,
      fileResolution.file.path,
    )
    if (!symbol) {
      return {
        ok: false,
        error: `Symbol '${name}' not found in ${fileResolution.file.path}.`,
      }
    }
    return { ok: true, symbol }
  }

  return {
    ok: false,
    error: 'Must provide either symbol_id or both name and file_path_or_name',
  }
}

/**
 * Resolves a file record from a partial name or path. Returns an error string
 * when zero or multiple files match.
 */
export async function resolveFile(
  store: IndexerDB,
  file_path_or_name: string,
): Promise<
  { ok: true; file: IndexedFile['Select'] } | { ok: false; error: string }
> {
  const files = await store.files.getByPartialNameOrPath(file_path_or_name)
  if (files.length === 0) {
    return { ok: false, error: `No file found matching: ${file_path_or_name}` }
  }
  if (files.length > 1) {
    const fileList = files.map((f) => `  - ${f.path}`).join('\n')
    return {
      ok: false,
      error: `Multiple files found matching '${file_path_or_name}':\n${fileList}\nPlease provide a more specific file path or name to disambiguate.`,
    }
  }
  return { ok: true, file: files[0]! }
}
