import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'path'
import { logDebug } from 'src/utils/logger'

/** Builds and prepares a distributable version of the application by generating an executable script and ensuring all necessary directories exist. */
export async function build() {
  const currentDir = import.meta.dir
  const distDir = resolve(currentDir, '../dist')
  const rootDir = dirname(distDir)

  //   Ensure the dist directory exists
  await mkdir(distDir, { recursive: true })

  //   Create the agentic_indexer file with the shebang and environment variable
  let agenticIndexerContent = `#!/bin/bash \n`
  agenticIndexerContent += `bun --env-file ${rootDir}/.env ${rootDir}/index.ts "$@"\n`

  //   Write the agentic_indexer file to the dist directory
  const agenticIndexerPath = resolve(distDir, 'agentic_indexer')
  await Bun.write(agenticIndexerPath, agenticIndexerContent)

  //   Make the agentic_indexer file executable
  await Bun.$`chmod +x ${agenticIndexerPath}`

  logDebug(`Build completed. Executable created at: ${agenticIndexerPath}`)
}

await build()
