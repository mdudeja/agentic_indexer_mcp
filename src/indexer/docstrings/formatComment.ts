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
    if (
      lines[0]?.startsWith('/**') &&
      lines[lines.length - 1]?.endsWith('*/')
    ) {
      return docstring
    }

    if (lines.length === 1) return `/** ${lines[0]} */`
    return `/**\n${lines.map((l) => ` * ${l}`).join('\n')}\n */`
  }

  if (language === 'python') {
    if (
      lines[0]?.startsWith('"""') &&
      lines[lines.length - 1]?.endsWith('"""')
    ) {
      return docstring
    }

    if (lines.length === 1) return `""" ${lines[0]} """`
    return `"""\n${lines.join('\n')}\n"""`
  }

  if (lines[0]?.startsWith('#')) {
    return docstring
  }

  if (lines.length === 1) return `# ${lines[0]}`
  return lines.map((l) => `# ${l}`).join('\n')
}
