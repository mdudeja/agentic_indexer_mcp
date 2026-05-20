/** Formats a given string into a language-specific comment by removing existing markers and applying new syntax based on the specified programming language. */
export function formatComment(docstring: string, language: string): string {
  const lines = docstring
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  // Remove all existing comment syntax from the docstring
  const commentSyntax = [/^\/\*\*?/, /^\*\/?/, /^\/\/+/, /^#+/]
  lines.forEach((line, idx) => {
    commentSyntax.forEach((regex) => {
      if (regex.test(line)) {
        lines[idx] = line.replace(regex, '').trim()
      }
    })
  })

  if (
    language === 'typescript' ||
    language === 'tsx' ||
    language === 'javascript'
  ) {
    if (lines.length === 1) return `/** ${lines[0]} */`
    return `/**\n${lines.map((l) => ` * ${l}`).join('\n')}\n */`
  }

  if (language === 'python') {
    if (lines.length === 1) return `""" ${lines[0]} """`
    return `"""\n${lines.join('\n')}\n"""`
  }

  if (lines.length === 1) return `# ${lines[0]}`
  return lines.map((l) => `# ${l}`).join('\n')
}
