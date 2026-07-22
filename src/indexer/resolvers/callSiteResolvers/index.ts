export * from './CallSiteResolver'
export * from './PythonCallSiteResolver'
export * from './TypescriptCallSiteResolver'

/** Removes any leading and trailing parentheses from the given string. */
export function removeWrappingParenthesis(str: string): string {
  if (!str || str.length === 0) {
    return str
  }

  const matchingPairs: Record<number, { start: number; end: number }[]> = {}

  // loop through the characters of the string, keeping track of the depth of parentheses
  let depth = 0
  for (let i = 0; i < str.length; i++) {
    const char = str[i]
    if (char === '(') {
      depth++
      if (!matchingPairs[depth]) {
        matchingPairs[depth] = []
      }
      matchingPairs[depth]!.push({ start: i, end: -1 })
    }

    if (char === ')') {
      if (!matchingPairs[depth]) {
        matchingPairs[depth] = []
        matchingPairs[depth]!.push({ start: -1, end: -1 })
      }
      matchingPairs[depth]![matchingPairs[depth]!.length - 1]!.end = i
      depth--
    }
  }

  for (const depth in matchingPairs) {
    for (const pair of matchingPairs[depth] || []) {
      let unbalancedValue = -1
      if (pair.start === -1) {
        unbalancedValue = pair.end
      }
      if (pair.end === -1) {
        unbalancedValue = pair.start
      }

      if (unbalancedValue !== -1) {
        str =
          str.substring(0, unbalancedValue) + str.substring(unbalancedValue + 1)
      }

      if (pair.start === 0 && pair.end === str.length - 1) {
        str = str.substring(1, str.length - 1)
      }
    }
  }

  return str
}
