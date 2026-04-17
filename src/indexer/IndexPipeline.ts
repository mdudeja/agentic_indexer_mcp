import { join, relative } from 'path'
import { readdirSync, statSync, readFileSync } from 'fs'
import { TreeSitterIndexer } from './TreeSitterIndexer.ts'
import type { IndexerDB } from '../database/IndexerDB.ts'
export interface IndexPipelineOptions {
  cwd: string
  store: IndexerDB
  extensions: string[]
  // For now ignore complex .gitignore logic, just basic ignore patterns
  ignorePatterns: string[]
}

export class IndexPipeline {
  private indexer: TreeSitterIndexer

  constructor(private options: IndexPipelineOptions) {
    this.indexer = new TreeSitterIndexer()
  }

  async run() {
    console.error(`[indexer] Starting index pipeline in ${this.options.cwd}...`)
    const files = this.findFiles(this.options.cwd)
    let processed = 0

    for (const absPath of files) {
      const relPath = relative(this.options.cwd, absPath)

      const content = readFileSync(absPath, 'utf8')
      const ext = absPath.split('.').pop() || ''

      const hasher = new Bun.CryptoHasher('sha256')
      hasher.update(content)
      const hash = hasher.digest('hex')

      const currentHash = await this.options.store.getFileHash(relPath)

      if (currentHash === hash) {
        // Skip unmodified file
        continue
      }

      console.error(`[indexer] Indexing: ${relPath}`)

      // Parse and extract using TreeSitterIndexer
      const parsed = await this.indexer.parse(
        content,
        ext,
        relPath,
      )

      if (!parsed) continue

      // Save
      await this.options.store.upsertFile({
        path: relPath,
        hash,
        language: ext,
      })
      await this.options.store.upsertSymbols(parsed.symbols)
      await this.options.store.upsertImports(parsed.imports)

      processed++
    }

    console.error(
      `[indexer] Indexed ${processed} files. Total found: ${files.length}`,
    )
  }

  async runOnFile(absPath: string) {
    const relPath = relative(this.options.cwd, absPath)
    if (this.options.ignorePatterns.some((p) => relPath.includes(p))) return

    const ext = absPath.split('.').pop() || ''
    if (!this.options.extensions.includes(ext)) return

    try {
      const content = readFileSync(absPath, 'utf8')
      const hasher = new Bun.CryptoHasher('sha256')
      hasher.update(content)
      const hash = hasher.digest('hex')

      const currentHash = await this.options.store.getFileHash(relPath)
      if (currentHash === hash) return

      const parsed = await this.indexer.parse(content, ext, relPath)
      if (!parsed) return

      await this.options.store.upsertFile({ path: relPath, hash, language: ext })
      await this.options.store.upsertSymbols(parsed.symbols)
      await this.options.store.upsertImports(parsed.imports)
      console.error(`[watcher] Re-indexed: ${relPath}`)
    } catch(e) {
      console.error(`[watcher] Failed to index ${relPath}:`, e)
    }
  }

  private findFiles(dir: string, fileList: string[] = []): string[] {
    const files = readdirSync(dir)

    for (const file of files) {
      if (this.options.ignorePatterns.some((p) => file.includes(p))) {
        continue
      }

      const absPath = join(dir, file)
      const stat = statSync(absPath)

      if (stat.isDirectory()) {
        this.findFiles(absPath, fileList)
      } else {
        const ext = absPath.split('.').pop()
        if (ext && this.options.extensions.includes(ext)) {
          fileList.push(absPath)
        }
      }
    }

    return fileList
  }
}
