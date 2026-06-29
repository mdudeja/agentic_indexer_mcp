import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'

describe('CLI Integration Tests', () => {
  const projectRoot = path.resolve(path.join(import.meta.dir, '..'))
  const fixturePath = path.join(import.meta.dir, 'fixtures/test-project')
  const testDbPath = path.join(import.meta.dir, 'test-cli.db')
  const migrationsDir = path.join(projectRoot, 'drizzle_migrations')

  const env = {
    ...process.env,
    DB_FILE_URL: testDbPath,
    DB_MIGRATIONS_DIR: migrationsDir,
    LOG_LEVEL: 'INFO', // allow INFO logs to verify indexed count
  }

  beforeAll(() => {
    // Delete existing test DB if any
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath)
    }
  })

  afterAll(() => {
    // Cleanup temporary CLI database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath)
    }
    const shmFile = `${testDbPath}-shm`
    const walFile = `${testDbPath}-wal`
    if (fs.existsSync(shmFile)) {
      fs.unlinkSync(shmFile)
    }
    if (fs.existsSync(walFile)) {
      fs.unlinkSync(walFile)
    }
  })

  it('should run one-off index command on test project', () => {
    const result = spawnSync(
      'bun',
      ['run', 'index.ts', 'index', '--cwd', fixturePath],
      { env, encoding: 'utf-8' },
    )

    expect(result.status).toBe(0)
    expect(fs.existsSync(testDbPath)).toBe(true)
    expect(result.stderr).toContain('Indexed 4 files')
  })

  it('should query indexed symbols using query command', () => {
    const result = spawnSync(
      'bun',
      ['run', 'index.ts', 'query', '--query', 'add', '--cwd', fixturePath],
      { env, encoding: 'utf-8' },
    )

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('[FUNCTION] add')
    expect(result.stderr).toContain('File: math.ts:2')
  })

  it('should fail query command if --query option is missing', () => {
    const result = spawnSync(
      'bun',
      ['run', 'index.ts', 'query', '--cwd', fixturePath],
      { env, encoding: 'utf-8' },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Error: --query is required')
  })

  it('should execute remove-docstrings command', () => {
    const result = spawnSync(
      'bun',
      ['run', 'index.ts', 'remove-docstrings', '--cwd', fixturePath],
      { env, encoding: 'utf-8' },
    )

    expect(result.status).toBe(0)
  })
})
