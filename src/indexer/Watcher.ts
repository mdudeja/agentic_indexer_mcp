import { watch, type FSWatcher } from 'chokidar'
import { IndexPipeline } from './IndexPipeline'
import { IndexerDB } from '../database/IndexerDB'
import { relative } from 'path'
import { logInfo, logError } from 'src/utils/logger'

export class Watcher {
  private watcher: FSWatcher | null = null

  constructor(private cwd: string) {}

  start() {
    logInfo(`[watcher] Starting file watcher for ${this.cwd}`)

    this.watcher = watch(this.cwd, {
      ignored: /(^|[\/\\])(\..+|node_modules|dist|build)/, 
      persistent: true,
      ignoreInitial: true, 
    })

    const db = IndexerDB.getInstance()
    const pipeline = new IndexPipeline({
      cwd: this.cwd,
      store: db,
      includeGitIgnored: false,
    })

    this.watcher
      .on('add', async (path) => { await pipeline.runOnFile(path) })
      .on('change', async (path) => { await pipeline.runOnFile(path) })
      .on('unlink', async (path) => {
        const relPath = relative(this.cwd, path)
        await db.deleteFile(relPath)
        logInfo(`[watcher] Unlinked file: ${relPath}`)
      })
      .on('error', (error) => logError(`[watcher] Error: ${error}`))
  }

  stop() {
    if (this.watcher) {
      this.watcher.close()
    }
  }
}
