import * as fs from 'fs'
import * as path from 'path'
import { TreeSitterIndexer } from 'src/indexer/TreeSitterIndexer'
import { default_config } from 'src/config/default_config'

/** Generates a formatted string representation of a node and its children, useful for debugging or visualizing tree structures. The output includes indentation based on depth and parentheses to denote nested nodes. */
function printNode(node: any, source: string, depth: number, fieldName?: string): string {
  if (!node.isNamed) return ''

  const indent = '  '.repeat(depth)
  const label = fieldName ? `${fieldName}: ` : ''

  if (node.childCount === 0) {
    const text = source.slice(node.startIndex, node.endIndex)
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
    return `${indent}${label}(${node.type} "${escaped}")`
  }

  let result = `${indent}${label}(${node.type}`
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child?.isNamed) continue
    const childField: string | null = node.fieldNameForChild(i)
    const childStr = printNode(child, source, depth + 1, childField ?? undefined)
    if (childStr) result += '\n' + childStr
  }
  return result + ')'
}

/** Prints the abstract syntax tree (AST) of a given source code file to the console. */
export async function printTree(filePath: string): Promise<void> {
  const absPath = path.resolve(filePath)
  const ext = path.extname(absPath).slice(1)
  const sourceCode = fs.readFileSync(absPath, 'utf-8')

  const langName = default_config.indexer.extnToLangMap[ext]
  if (!langName) {
    console.error(`No language mapping for extension: .${ext}`)
    process.exit(1)
  }

  const indexer = new TreeSitterIndexer()
  await indexer.init()
  const tree = await indexer.parseFile(sourceCode, langName)
  console.log(printNode(tree.rootNode, sourceCode, 0))
}

const filePath = process.argv[2]
if (!filePath) {
  console.error('Usage: bun run scripts/print_tree.ts <file-path>')
  process.exit(1)
}

printTree(filePath).catch((err) => {
  console.error(err)
  process.exit(1)
})
