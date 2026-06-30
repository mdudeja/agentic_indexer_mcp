import { spawn } from 'bun'
import { afterAll, beforeAll } from 'bun:test'
import { existsSync, unlinkSync, rmSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { loadConfig } from 'src/config/loader'
import { IndexerDB } from 'src/database/IndexerDB'
import { IndexPipeline } from 'src/indexer/IndexPipeline'
import { AppStateManager } from 'src/state'
import { resolvePath } from 'src/utils/paths'

let store: IndexerDB
let pipeline: IndexPipeline

export function clearDB() {
  const testDbPath = join(
    resolve(process.env.TEST_FIXTURES_DIR as string),
    process.env.DB_FILE_URL as string,
  )
  if (existsSync(testDbPath)) {
    unlinkSync(testDbPath)
  }
  const shmFile = `${testDbPath}-shm`
  const walFile = `${testDbPath}-wal`
  if (existsSync(shmFile)) {
    unlinkSync(shmFile)
  }
  if (existsSync(walFile)) {
    unlinkSync(walFile)
  }

  const testDbDir = dirname(dirname(testDbPath))
  if (existsSync(testDbDir)) {
    rmSync(testDbDir, { recursive: true, force: true })
  }
}

async function runIndex(cwd: string) {
  const proc = spawn(['bun', 'run', 'index.ts', 'index', '--cwd', cwd], {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  await proc.exited
}

async function prepareTestEnvironment() {
  const fixturePath = resolvePath(process.env.TEST_FIXTURES_DIR as string)
  clearDB()
  await runIndex(fixturePath)

  // 1. Setup AppState config
  const config = await loadConfig(fixturePath)
  AppStateManager.getInstance().setItem('config', config)
  AppStateManager.getInstance().setItem('root', fixturePath)

  // 2. Initialize In-Memory DB
  store = IndexerDB.getInstance()
  await store.init()

  // 3. Create Pipeline
  pipeline = new IndexPipeline({
    cwd: fixturePath,
    store,
    includeGitIgnored: true,
  })
}

export function getPipelineForTests(): IndexPipeline {
  return pipeline
}

export function getStoreForTests(): IndexerDB {
  return store
}

beforeAll(async () => {
  clearDB()
  await prepareTestEnvironment()
}, 60000)

afterAll(() => {
  clearDB()
})
