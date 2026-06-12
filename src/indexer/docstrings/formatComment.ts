const commentSyntax = [
  /^\/\*\*?/,
  /^\*\/?/,
  /^\/\/+/,
  /^#+/,
  /^"""/,
  /^'''/,
  /^--+/,
  /```\s?(typescript|tsx|javascript|js|json|python|lua|bash|html|css)?/,
  /```\s?/,
  /"""\s?$/,
  /'''\s?$/,
  /--+\s?$/,
  /\*\/\s?$/,
]

/** This function converts a given docstring into the proper comment syntax for the specified programming language. It handles formatting for TypeScript/JavaScript, Python, and other languages by wrapping the text in language-appropriate comment markers. */
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

/** Extracts the textual content of a comment by removing any programming syntax markers. */
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
