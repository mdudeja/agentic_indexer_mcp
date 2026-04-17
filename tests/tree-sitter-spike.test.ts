import { logInfo } from 'src/utils/logger'
import { TreeSitterIndexer } from '../src/indexer/TreeSitterIndexer'
import { extractSymbols } from '../src/indexer/steps/symbol_extractor'


const sourceCode = `
/**
 * A handy dandy function
 */
export function greet(name: string): string {
  return \`Hello, \${name}\`
}

class Person {
  constructor(public name: string) {}
  
  /** Says hello */
  sayHello() {
    logInfo(greet(this.name))
  }
}

interface Animal {
  species: string
}

export type StringOrNumber = string | number

export const myConstant = 42
`

async function runSpike() {
  logInfo('Initializing indexer...')
  const indexer = new TreeSitterIndexer()
  await indexer.init()

  logInfo('Parsing file...')
  const tree = await indexer.parseFile(sourceCode, 'typescript')
  if (!tree) {
    console.error('Failed to parse source code')
    return
  }

  logInfo('Parse successful! Node count:', tree.rootNode.descendantCount)

  logInfo('Extracting symbols...')
  const { symbols } = extractSymbols(tree.rootNode, 'virtual-file.ts')

  logInfo('\\n--- Extracted Symbols ---')
  for (const sym of symbols) {
    logInfo(
      `[${sym.kind.toUpperCase()}] ${sym.name} (exported: ${sym.exported})`,
    )
    logInfo(`  Signature: ${sym.signature}`)
    if (sym.docstring) logInfo(`  Docstring: ${sym.docstring.trim()}`)
    logInfo(`  Lines: ${sym.line}-${sym.end_line}`)
    logInfo('---')
  }
}

runSpike().catch((err) => {
  console.error('Spike failed:', err)
  process.exit(1)
})
