import type { IndexedSymbol } from 'src/database/schemas/symbols.schema'

type Param = { name: string; type?: string; optional?: boolean }

/** Parses a symbol's parameters_json into a typed array, or null on failure. */
export function parseParameters(
  symbol: Pick<IndexedSymbol['Select'], 'parameters_json'>,
): Param[] | null {
  if (!symbol.parameters_json) return null
  try {
    return JSON.parse(symbol.parameters_json) as Param[]
  } catch {
    return null
  }
}

/** Formats a symbol's parameters as a comma-separated `name: type` string. */
export function formatParameters(
  symbol: Pick<IndexedSymbol['Select'], 'parameters_json'>,
): string {
  const params = parseParameters(symbol)
  if (!params || params.length === 0) return '(none)'
  return params
    .map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type ?? 'unknown'}`)
    .join(', ')
}

/** Formats a symbol's inheritance entries into a readable multi-line string. */
export function formatInheritence(
  symbol: Pick<IndexedSymbol['Select'], 'inheritence'>,
): string {
  if (!symbol.inheritence || symbol.inheritence.length === 0) return ''
  const lines = symbol.inheritence.map((item) => {
    const ref = item.inherits_from_id
      ? `id=${item.inherits_from_id}`
      : `imports_id=${item.inherits_from_imports_id}`
    return `  ${item.inheritence_type} ${item.inherits_from_name} (${ref})`
  })
  return `\n  Inheritence: ${lines.join('\n')}`
}

/** Extracts the top-level directory name from a given file path. Optionally allows specifying the maximum depth to extract if multiple directories are present. */
export function filePathToTopDir(filepath: string, maxDepth?: number): string {
  const parts = filepath.split('/')
  const dirParts = parts.slice(0, -1)
  const prefix =
    dirParts.length === 0
      ? '(root)'
      : dirParts.slice(0, maxDepth ?? 1).join('/')
  return prefix
}

/**
 * Builds a compact human-readable annotation describing how a call edge or
 * import was resolved, including its numeric confidence and resolution source.
 * Helps agents gauge the reliability of returned graph data.
 *
 * Returns an empty string when there is no meaningful resolution info so callers
 * can append it conditionally without changing their output shape when unused.
 */
export function formatResolutionAnnotation(opts: {
  confidence?: number | null
  resolutionSource?: string | null
  unresolvedWhenNull?: boolean
}): string {
  const { confidence, resolutionSource, unresolvedWhenNull = true } = opts

  // No resolution data captured at all — nothing to annotate.
  if (confidence == null && !resolutionSource) return ''

  const hasConfidence = confidence != null
  const sourceLabel = resolutionSource || 'unresolved'

  // A confidence of 0 with no source implies the resolution failed / was never
  // attempted. Surface it as "unresolved" so agents don't misread it.
  if (hasConfidence && confidence === 0 && unresolvedWhenNull) {
    return ` [resolution: unresolved, confidence 0]`
  }

  const parts: string[] = []
  if (resolutionSource) parts.push(sourceLabel)
  if (hasConfidence) parts.push(`confidence ${confidence}`)
  return ` [resolution: ${parts.join(', ')}]`
}
