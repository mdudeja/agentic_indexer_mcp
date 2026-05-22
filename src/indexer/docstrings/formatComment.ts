const commentSyntax = [
  /^\/\*\*?/,
  /^\*\/?/,
  /^\/\/+/,
  /^#+/,
  /^"""/,
  /^'''/,
  /^--+/,
  /^```\s*[a-zA-Z0-9_-]*$/,
  /^```$/,
  /"""$/,
  /'''$/,
  /--+$/,
  /\*\/$/,
  /^```$/,
]

/**
 * A function that formats a docstring into the appropriate comment syntax for a specified programming language. It processes the input docstring by removing existing comment syntax and then applies formatting specific to the target language (TypeScript/JavaScript, Python, or others). The formatted string is returned as a single line or multi-line comment based on the language requirements.
 * Parameters:
 * - `docstring`: The input text to be formatted.
 * - `language`: The programming language determining the output format.
 * Returns:
 * The formatted docstring as a comment in the specified language's syntax.
 */
export function formatComment(docstring: string, language: string): string {
  const lines = docstring
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  // Remove all existing comment syntax from the docstring
  lines.forEach((_, idx) => {
    commentSyntax.forEach((regex) => {
      if (regex.test(lines[idx]!)) {
        lines[idx] = lines[idx]!.replace(regex, '').trim()
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

/** A function that processes a formatted comment string to extract and return the cleaned text content by removing specific comment syntax patterns. */
export function getCommentText(formattedComment: string): string {
  const lines = formattedComment.split('\n').map((l) => l.trim())
  const textLines: string[] = []
  lines.forEach((line) => {
    let textLine = line
    commentSyntax.forEach((regex) => {
      if (regex.test(textLine)) {
        textLine = textLine.replace(regex, '').trim()
      }
    })
    if (textLine) textLines.push(textLine)
  })
  return textLines.join('\n')
}
