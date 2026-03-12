import { TreeSitterIndexer } from '../src/indexer/TreeSitterIndexer'
import { extractTypeScriptSymbols } from '../src/indexer/languages/typescript'
import type { IndexerConfig } from '../src/indexer/types'

const config: IndexerConfig = {
  enabled: true,
  languages: {
    typescript: {
      extensions: ['.ts', '.tsx'],
      treesitter: {
        parser: undefined, // forces WASM fallback
      },
    },
  },
}

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
    console.log(greet(this.name))
  }
}

interface Animal {
  species: string
}

export type StringOrNumber = string | number

export const myConstant = 42
`

async function runSpike() {
  console.log('Initializing indexer...')
  const indexer = new TreeSitterIndexer()
  await indexer.init(config)

  console.log('Parsing file...')
  const tree = await indexer.parseFile(sourceCode, 'typescript')
  if (!tree) {
    console.error('Failed to parse source code')
    return
  }

  console.log('Parse successful! Node count:', tree.rootNode.descendantCount)

  console.log('Extracting symbols...')
  const symbols = extractTypeScriptSymbols(tree.rootNode, 'virtual-file.ts')

  console.log('\\n--- Extracted Symbols ---')
  for (const sym of symbols) {
    console.log(
      `[${sym.kind.toUpperCase()}] ${sym.name} (exported: ${sym.exported})`,
    )
    console.log(`  Signature: ${sym.signature}`)
    if (sym.docstring) console.log(`  Docstring: ${sym.docstring.trim()}`)
    console.log(`  Lines: ${sym.line}-${sym.endLine}`)
    console.log('---')
  }
}

runSpike().catch((err) => {
  console.error('Spike failed:', err)
  process.exit(1)
})
