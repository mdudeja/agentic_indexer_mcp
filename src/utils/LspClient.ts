import { readFileSync } from 'fs'
import { join } from 'path'
import { logDebug, logError } from './logger.ts'
import { resolveWorkspacePath } from './paths.ts'

/** A lightweight, Bun-native LSP client implementation communicating over JSON-RPC stdio. */
export class LspClient {
  private process?: ReturnType<typeof Bun.spawn>
  private messageId = 0
  private pendingRequests = new Map<
    number,
    { resolve: (res: any) => void; reject: (err: any) => void; method: string }
  >()
  private rawBuffer = Buffer.alloc(0)
  private serverCapabilities: Record<string, any> = {}
  /** URIs the server has published at least one `textDocument/publishDiagnostics` notification for since they were last opened/changed — used as a settle signal that the server has actually finished analyzing the file, instead of guessing with a fixed sleep. */
  private diagnosticsReceivedUris = new Set<string>()
  private initialized = false
  private openDocuments = new Set<string>()

  /** Gets the server's capabilities. */
  getCapabilities(): Record<string, any> {
    return this.serverCapabilities
  }

  /** The constructor initializes an LSP (Language Server Protocol) client with specific commands and a root path, preparing it to communicate with an LSP server. */
  constructor(
    private lspCommand: string[],
    private rootPath: string,
  ) {}

  /** Starts the language server child process and handles standard JSON-RPC initialization. */
  async start(): Promise<void> {
    logDebug(`[LSP] Spawning LSP server process: ${this.lspCommand.join(' ')}`)
    this.process = Bun.spawn(this.lspCommand, {
      cwd: this.rootPath,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    // Start background loops to read output
    this.readStdout()
    this.readStderr()

    // Initialize request
    const resp = await this.request('initialize', {
      processId: null,
      rootPath: this.rootPath,
      rootUri: `file://${this.rootPath}`,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: false },
          references: {},
          implementation: { linkSupport: false },
          typeDefinition: { linkSupport: false },
          documentSymbol: {},
          publishDiagnostics: {},
        },
        workspace: {
          symbol: {},
        },
      },
    })

    this.serverCapabilities = resp?.capabilities ?? {}

    // Send initialized notification
    this.notify('initialized', {})
    logDebug(
      `[LSP] LSP server initialized successfully: ${this.lspCommand.join(' ')}`,
    )
    this.initialized = true
  }

  /** Determines whether a specified capability is supported by the server. */
  supports(capability: string): boolean {
    const cap = this.serverCapabilities[capability]
    return cap === true || (typeof cap === 'object' && cap !== null)
  }

  /** "Ensures the specified file is opened by notifying the language server if not already open." */
  ensureFileOpen(absPath: string, languageId: string): void {
    try {
      const resolvedPath = resolveWorkspacePath(absPath)
      if (!this.initialized || this.openDocuments.has(resolvedPath)) return
      const text = readFileSync(resolvedPath, 'utf8')
      this.notify('textDocument/didOpen', {
        textDocument: {
          uri: `file://${resolvedPath}`,
          languageId: languageId,
          version: 1,
          text,
        },
      })
      this.openDocuments.add(resolvedPath)
    } catch (err) {
      logError(`[LspClient - ${languageId}] Failed to open document:`, err)
    }
  }

  /** Updates the file at the given absolute path and notifies external systems (like language servers) about the change. */
  refreshFile(absPath: string): void {
    try {
      const resolvedPath = resolveWorkspacePath(absPath)
      if (!this.initialized || !this.openDocuments.has(resolvedPath)) return
      const text = readFileSync(resolvedPath, 'utf8')
      this.notify('textDocument/didChange', {
        textDocument: {
          uri: `file://${resolvedPath}`,
          version: Date.now(),
        },
        contentChanges: [{ text }],
      })
      // The file's content just changed, so any diagnostics the server
      // published for it are stale.
      this.invalidateDiagnostics(resolvedPath)
    } catch (err) {
      logError(`[LspClient] Failed to notify file changes:`, err)
    }
  }

  /** Closes the specified files by sending notifications to the language server and removing them from the list of open documents. */
  async closeFiles(relPaths: string[], cwd: string): Promise<void> {
    if (!this.initialized) return
    try {
      for (const relPath of relPaths) {
        const absPath = resolveWorkspacePath(join(cwd, relPath))
        if (!this.openDocuments.has(absPath)) continue
        this.notify('textDocument/didClose', {
          textDocument: {
            uri: `file://${absPath}`,
          },
        })
        this.openDocuments.delete(absPath)
      }
    } catch (err) {
      logError(`[LspClient] Failed to close files:`, err)
    }
  }

  /** Reads and processes the standard output from the LSP process. */
  private async readStdout(): Promise<void> {
    if (!this.process || !this.process.stdout) {
      logError('[LSP] Cannot read stdout: LSP process is not running')
      return
    }

    const reader = (
      this.process.stdout as ReadableStream<Uint8Array>
    ).getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          logError('[LSP] stdout stream ended (server process exited?)')
          break
        }

        this.rawBuffer = Buffer.concat([this.rawBuffer, value])
        this.processBuffer()
      }
    } catch (e) {
      logError('[LSP] Error in stdout stream reader:', e)
    }
  }

  /** Processes buffered data containing LSP (Language Server Protocol) messages. It extracts each message's header and body, parses the JSON content, and handles the parsed messages accordingly. */
  private processBuffer(): void {
    const HEADER_END = Buffer.from('\r\n\r\n')

    while (true) {
      const clIdx = this.rawBuffer.indexOf('Content-Length:')
      if (clIdx === -1) break

      const headerEndIdx = this.rawBuffer.indexOf(HEADER_END, clIdx)
      if (headerEndIdx === -1) break

      const headerSection = this.rawBuffer
        .subarray(clIdx, headerEndIdx)
        .toString('utf8')
      const clLine = headerSection
        .split('\r\n')
        .find((line) => line.startsWith('Content-Length:'))
      if (!clLine) {
        logError(`[LSP] Malformed header, skipping: ${headerSection}`)
        this.rawBuffer = this.rawBuffer.subarray(headerEndIdx + 4)
        continue
      }

      const contentLength = parseInt(clLine.split(':')[1]!.trim(), 10)
      const bodyStart = headerEndIdx + 4

      if (this.rawBuffer.length < bodyStart + contentLength) {
        // Incomplete message body, wait for next stream chunks
        break
      }

      const body = this.rawBuffer
        .subarray(bodyStart, bodyStart + contentLength)
        .toString('utf8')
      this.rawBuffer = this.rawBuffer.subarray(bodyStart + contentLength)

      try {
        const parsed = JSON.parse(body)
        this.handleMessage(parsed)
      } catch (err) {
        logError('[LSP] Failed to parse message body JSON:', err, 'body:', body)
      }
    }
  }

  /** Processes incoming Language Server Protocol (LSP) messages, handling server-initiated requests, notifications, and responses appropriately. */
  private handleMessage(msg: any): void {
    // Server-initiated request (has both id and method)
    if (msg.id !== undefined && msg.method) {
      this.send({ jsonrpc: '2.0', id: msg.id, result: null })
      return
    }

    // Server notification (no id, has method)
    if (msg.id === undefined && msg.method) {
      if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri) {
        this.diagnosticsReceivedUris.add(msg.params.uri)
      }
      return
    }

    // Response to a client request
    if (msg.id !== undefined) {
      if (this.pendingRequests.has(msg.id)) {
        const pending = this.pendingRequests.get(msg.id)!
        if (msg.error) {
          pending.reject(msg.error)
        } else {
          pending.resolve(msg.result)
        }
        this.pendingRequests.delete(msg.id)
      } else {
        logError(
          `[LSP] <-- response for unknown id=${msg.id} (no pending request). Pending ids: [${[...this.pendingRequests.keys()].join(', ')}]`,
        )
      }
      return
    }

    logError(`[LSP] <-- unrecognized message shape:`, JSON.stringify(msg))
  }

  /** Reads and logs any error output generated by the LSP (Language Server Protocol) process. This method monitors the standard error stream of the process to capture and record any issues or errors that occur during its operation. */
  private async readStderr(): Promise<void> {
    if (!this.process || !this.process.stderr) {
      logError('[LSP] Cannot read stderr: LSP process is not running')
      return
    }

    const reader = (
      this.process.stderr as ReadableStream<Uint8Array>
    ).getReader()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = new TextDecoder().decode(value)
        logDebug(`[LSP Stderr] ${text.trim()}`)
      }
    } catch (e) {
      // Process has likely exited
    }
  }

  /** Sends a message to the LSP process. The message is serialized as JSON and sent with appropriate headers. */
  private send(msg: any): void {
    if (!this.process || !this.process.stdin) {
      throw new Error('LSP process is not running or stdin is closed')
    }
    const json = JSON.stringify(msg)
    // Explicitly compute bytes length instead of string length (for UTF-8 safety)
    const length = Buffer.byteLength(json, 'utf-8')
    const payload = `Content-Length: ${length}\r\n\r\n${json}`
    ;(this.process.stdin as Bun.FileSink).write(payload)
    ;(this.process.stdin as Bun.FileSink).flush()
  }

  /** Sends a JSON-RPC notification to the language server. */
  notify(method: string, params: any): void {
    this.send({
      jsonrpc: '2.0',
      method,
      params,
    })
  }

  /** Drops the "diagnostics received" mark for a file, e.g. after it's been re-sent via `didChange`, so a subsequent `waitForDiagnostics` call waits for a fresh analysis pass rather than reusing a stale signal. */
  invalidateDiagnostics(absPath: string): void {
    this.diagnosticsReceivedUris.delete(`file://${absPath}`)
  }

  /**
   * Blocks until the server has published at least one
   * `textDocument/publishDiagnostics` notification for every given file (or
   * the timeout elapses).
   */
  async waitForDiagnostics(
    absPaths: string[],
    timeoutMs = 20000,
  ): Promise<void> {
    const uris = absPaths.map((p) => `file://${p}`)
    const pollIntervalMs = 50
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (uris.every((uri) => this.diagnosticsReceivedUris.has(uri))) return
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }

    const missing = uris.filter((uri) => !this.diagnosticsReceivedUris.has(uri))
    if (missing.length > 0) {
      logDebug(
        `[LSP] Timed out after ${timeoutMs}ms waiting for diagnostics on ${missing.length}/${uris.length} file(s); proceeding anyway.`,
      )
    }
  }

  /** Sends a JSON-RPC request to the language server and returns a promise for the result. */
  request(method: string, params: any, timeoutMs?: number): Promise<any> {
    const id = this.messageId++

    const requestPromise = new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, method })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        logError(`[LSP] --> request send failed: ${method} (id=${id}):`, err)
        this.pendingRequests.delete(id)
        reject(err)
      }
    })

    if (!timeoutMs) return requestPromise

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => {
        if (!this.pendingRequests.has(id)) return
        this.pendingRequests.delete(id)
        logError(
          `[LSP] Request timed out: ${method} (id=${id}) after ${timeoutMs}ms — server may be stuck on type inference`,
        )
        reject(new Error(`LSP request timeout after ${timeoutMs}ms: ${method}`))
      }, timeoutMs),
    )

    return Promise.race([requestPromise, timeoutPromise])
  }

  /** Gracefully terminates the language server. */
  async stop(): Promise<void> {
    if (!this.process) return
    try {
      await this.request('shutdown', {})
      this.notify('exit', {})
      this.process.kill()
    } catch (e) {
      if (this.process) {
        this.process.kill()
      }
    }
  }
}
