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
let appStateManager: AppStateManager

/** Clears all test database files and ensures a clean testing environment by removing associated data files and directories. */
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

/** Prepares the test environment by initializing required configurations, clearing the database, running indexes, and setting up the testing pipeline. */
async function prepareTestEnvironment() {
  const fixturePath = resolvePath(
    process.env.TEST_FIXTURES_DIR as string,
    resolve(import.meta.dir, '../'),
  )
  clearDB()

  // 1. Setup AppState config
  const config = await loadConfig(fixturePath)

  appStateManager = AppStateManager.getInstance()
  appStateManager.setItem('config', config)
  appStateManager.setItem('root', fixturePath)
  appStateManager.setItem('includeGitIgnored', false)

  // 2. Initialize In-Memory DB
  store = IndexerDB.getInstance()
  await store.init()

  // 3. Create Pipeline
  pipeline = new IndexPipeline({
    cwd: fixturePath,
    store,
  })

  await pipeline.run()
}

/** Retrieves a predefined IndexPipeline optimized for testing purposes. */
export function getPipelineForTests(): IndexPipeline {
  return pipeline
}

/** Retrieves the store instance for use in test environments. */
export function getStoreForTests(): IndexerDB {
  return store
}

/** Retrieves the application state manager instance, intended for use in test environments. */
export function getAppStateManagerForTests(): AppStateManager {
  return appStateManager
}

beforeAll(async () => {
  clearDB()
  await prepareTestEnvironment()
}, 60000)

afterAll(() => {
  clearDB()
})
