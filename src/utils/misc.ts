/** Truncates a string by shortening it if its length exceeds a specified maximum, appending an ellipsis ('…') when shortened. */
export function truncate(s: string, max_length: number): string {
  return s.length > max_length ? s.slice(0, max_length - 1) + '…' : s
}

/**
 * Splits a comma-separated type list respecting bracket depth, strips generic
 * parameters, and returns bare identifier names. Caller is responsible for
 * filtering out unresolved names via a DB lookup.
 */
export function parseTypeNames(raw: string): string[] {
  const results: string[] = []
  let depth = 0
  let current = ''

  for (const ch of raw) {
    if (ch === '<' || ch === '[' || ch === '(') {
      depth++
      current += ch
    } else if (ch === '>' || ch === ']' || ch === ')') {
      depth--
      current += ch
    } else if (ch === ',' && depth === 0) {
      flush()
    } else {
      current += ch
    }
  }
  flush()
  return results

  function flush() {
    // Strip generic params and array/tuple suffixes, keep the bare name
    const name = current
      .replace(/<[\s\S]*>/g, '')
      .replace(/\[.*\]/g, '')
      .replace(/\?$/, '')
      .trim()
    current = ''
    // Accept valid identifiers with optional namespace dots (e.g. "pkg.Type")
    if (name && /^[A-Za-z_][\w.]*$/.test(name)) results.push(name)
  }
}
