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

  /** Flushes and processes the current string to extract a valid identifier name. */
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

/** Gets the parent symbols or classes before a specific symbol call in a given code context. This function extracts hierarchical parents by analyzing the text before the specified callee name, ignoring nested structures like parentheses to avoid including irrelevant separators within arguments. */
export function getParentsOfSymbolCall(
  callText: string,
  callee_name: string,
): string[] {
  const separators = ['.', '->', '::', '?.', '!.', '#']
  const separatorRegex = new RegExp(separators.map((s) => `\\${s}`).join('|'))

  callText = callText.trim().replace(/\s+/g, '')
  callText = callText.substring(
    0,
    callText.search(
      new RegExp(`\\b${callee_name.replaceAll(/[\$\^]/g, '')}\\b`),
    ),
  )

  // Strip paren contents so separators inside argument lists are ignored.
  // Each pass removes the innermost parens; repeat until none remain.
  let prev: string
  do {
    prev = callText
    callText = callText.replace(/\([^()]*\)/g, '')
  } while (callText !== prev)

  // split by separators and filter out empty parts
  const parts = callText.split(separatorRegex).filter(Boolean)

  // further clean up each parent part by removing function call parentheses and array indexing
  for (let i = 0; i < parts.length - 1; i++) {
    parts[i] = (parts[i] ?? '').replace(/\(.*\)/g, '').replace(/\[.*\]/g, '')
  }

  return parts.filter((part) => part && part.length > 0)
}

/** Parses a string of function arguments, correctly handling nested parentheses, brackets, and braces to ensure that commas within these structures do not split the arguments incorrectly.
 * Returns an array of individual argument strings. */
export function parseArguments(argString: string): string[] {
  const args: string[] = []
  let depth = 0
  let currentArg = ''

  for (const char of argString) {
    if (char === '(' || char === '[' || char === '{' || char === '<') {
      depth++
      currentArg += char
    } else if (char === ')' || char === ']' || char === '}' || char === '>') {
      depth--
      currentArg += char
    } else if (char === ',' && depth === 0) {
      args.push(currentArg.trim())
      currentArg = ''
    } else {
      currentArg += char
    }
  }

  if (currentArg.trim() !== '') {
    args.push(currentArg.trim())
  }

  return args
    .map((arg) => arg.replace(/\s+/g, ' '))
    .filter((arg) => arg.length > 0)
}
