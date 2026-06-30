import { describe, expect, test } from 'bun:test'
import { spawn } from 'bun'
import * as fs from 'fs'
import { join, resolve } from 'path'
import { clearDB } from '../scripts/test_setup'

describe('CLI Integration Tests', () => {
  const fixturePath = resolve(process.env.TEST_FIXTURES_DIR as string)

  test('should run one-off index command on test project', async () => {
    clearDB()
    const proc = spawn(
      ['bun', 'run', 'index.ts', 'index', '--cwd', fixturePath],
      {
        env: { ...process.env, LOG_LEVEL: 'debug' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    await proc.exited
    const text = await new Response(proc.stderr as ReadableStream).text()

    expect(proc.exitCode).toBeOneOf([0, 1]) // Allow exit code 1 for cases where no docstrings were generated
    expect(
      fs.existsSync(join(fixturePath, process.env.DB_FILE_URL as string)),
    ).toBe(true)
    expect(text).toContain('Indexed 4 files.')
    expect(text).toContain('Running Step 1:')
    expect(text).toContain('Running Step 2:')
    expect(text).toContain('Running Step 3:')
    expect(text).toContain('Symbol needing docstring')
    expect(text).toContain('sqlite-vec virtual table initialized')
  }, 30000)

  test('should query indexed symbols using query command', async () => {
    const proc = spawn(
      [
        'bun',
        'run',
        'index.ts',
        'query',
        '--query',
        'add',
        '--cwd',
        fixturePath,
      ],
      {
        env: { ...process.env, LOG_LEVEL: 'debug' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    await proc.exited
    const text = await new Response(proc.stderr as ReadableStream).text()

    expect(proc.exitCode).toBe(0)
    expect(text).toContain('[FUNCTION] add')
    expect(text).toContain('File: math.ts')
  })

  test('should fail query command if --query option is missing', async () => {
    const proc = spawn(
      ['bun', 'run', 'index.ts', 'query', '--cwd', fixturePath],
      {
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    await proc.exited
    const text = await new Response(proc.stderr as ReadableStream).text()

    expect(proc.exitCode).toBe(1)
    expect(text).toContain('Error: --query is required')
  })

  test('should execute remove-docstrings command', async () => {
    const proc = spawn(
      ['bun', 'run', 'index.ts', 'remove-docstrings', '--cwd', fixturePath],
      {
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    await proc.exited

    expect(proc.exitCode).toBe(0)
  })
})
