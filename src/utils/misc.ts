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
}

export function getParentsOfSymbolCall(
  callText: string,
  callee_name: string,
): string[] {
  const separators = ['.', '->', '::', '?.', '!.', '#']
  const separatorRegex = new RegExp(separators.map((s) => `\\${s}`).join('|'))

  callText = callText.trim().substring(0, callText.indexOf(callee_name))

  // Strip paren contents so separators inside argument lists are ignored.
  // Each pass removes the innermost parens; repeat until none remain.
  let prev: string
  do {
    prev = callText
    callText = callText.replace(/\([^()]*\)/g, '')
  } while (callText !== prev)

  // split by separators and filter out empty parts
  const parts = callText.split(separatorRegex).filter(Boolean)

  // if there's only one part, there are no parents to resolve
  if (parts.length <= 1) return []

  // further clean up each parent part by removing function call parentheses and array indexing
  for (let i = 0; i < parts.length - 1; i++) {
    parts[i] = (parts[i] ?? '').replace(/\(.*\)/g, '').replace(/\[.*\]/g, '')
  }

  return parts.filter((part) => part && part.length > 0)
}

export function getTypeNameWithoutParent(typeName: string): string {
  const separators = ['.', '->', '::', '?.', '!.', '#']
  const separatorRegex = new RegExp(separators.map((s) => `\\${s}`).join('|'))
  const parts = typeName.split(separatorRegex).filter(Boolean)
  return parts.length > 0 ? parts.at(-1)! : typeName
}
