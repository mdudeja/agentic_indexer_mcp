export function formatComment(docstring: string, language: string): string {
  const lines = docstring
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  if (
    language === 'typescript' ||
    language === 'tsx' ||
    language === 'javascript'
  ) {
    if (lines.length === 1) return `/** ${lines[0]} */`
    return `/**\n${lines.map((l) => ` * ${l}`).join('\n')}\n */`
  }

  if (language === 'python') {
    return `"""\n${lines.join('\n')}\n"""`
  }

  return lines.map((l) => `# ${l}`).join('\n')
}
