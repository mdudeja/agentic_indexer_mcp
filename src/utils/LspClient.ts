import { logDebug, logError } from './logger.ts';

/** A lightweight, Bun-native LSP client implementation communicating over JSON-RPC stdio. */
export class LspClient {
  private process: any;
  private messageId = 0;
  private pendingRequests = new Map<number, { resolve: (res: any) => void; reject: (err: any) => void }>();
  private buffer = '';

  constructor(private lspBinaryPath: string, private rootPath: string) {}

  /** Starts the language server child process and handles standard JSON-RPC initialization. */
  async start(): Promise<void> {
    logDebug(`[LSP] Spawning LSP server process: ${this.lspBinaryPath}`);
    this.process = Bun.spawn([this.lspBinaryPath, '--stdio'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Start background loops to read output
    this.readStdout();
    this.readStderr();

    // Initialize request
    await this.request('initialize', {
      processId: null,
      rootPath: this.rootPath,
      rootUri: `file://${this.rootPath}`,
      capabilities: {
        textDocument: {
          hover: {
            contentFormat: ['markdown', 'plaintext'],
          },
        },
      },
    });

    // Send initialized notification
    this.notify('initialized', {});
    logDebug(`[LSP] LSP server initialized successfully: ${this.lspBinaryPath}`);
  }

  private async readStdout(): Promise<void> {
    const reader = this.process.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = new TextDecoder().decode(value);
        this.buffer += chunk;
        this.processBuffer();
      }
    } catch (e) {
      logError('[LSP] Error in stdout stream reader:', e);
    }
  }

  private processBuffer(): void {
    while (true) {
      const contentLengthIndex = this.buffer.indexOf('Content-Length:');
      if (contentLengthIndex === -1) break;

      const headerEndIndex = this.buffer.indexOf('\r\n\r\n', contentLengthIndex);
      if (headerEndIndex === -1) break;

      const headerLines = this.buffer.slice(contentLengthIndex, headerEndIndex).split('\r\n');
      const contentLengthLine = headerLines.find((line) => line.startsWith('Content-Length:'));
      if (!contentLengthLine) {
        // Skip malformed header
        this.buffer = this.buffer.slice(headerEndIndex + 4);
        continue;
      }

      const contentLength = parseInt(contentLengthLine.split(':')[1]!.trim(), 10);
      const messageStartIndex = headerEndIndex + 4;

      if (this.buffer.length < messageStartIndex + contentLength) {
        // Incomplete message body, wait for next stream chunks
        break;
      }

      const body = this.buffer.slice(messageStartIndex, messageStartIndex + contentLength);
      this.buffer = this.buffer.slice(messageStartIndex + contentLength);

      try {
        const parsed = JSON.parse(body);
        this.handleMessage(parsed);
      } catch (err) {
        logError('[LSP] Failed to parse message body JSON:', err);
      }
    }
  }

  private handleMessage(msg: any): void {
    if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
      const promise = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        promise.reject(msg.error);
      } else {
        promise.resolve(msg.result);
      }
    }
  }

  private async readStderr(): Promise<void> {
    const reader = this.process.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = new TextDecoder().decode(value);
        // Log stderr as debug logging
        logDebug(`[LSP Stderr] ${text.trim()}`);
      }
    } catch (e) {
      // Process has likely exited
    }
  }

  private send(msg: any): void {
    if (!this.process || !this.process.stdin) {
      throw new Error('LSP process is not running or stdin is closed');
    }
    const json = JSON.stringify(msg);
    // Explicitly compute bytes length instead of string length (for UTF-8 safety)
    const length = Buffer.byteLength(json, 'utf-8');
    const payload = `Content-Length: ${length}\r\n\r\n${json}`;
    this.process.stdin.write(payload);
    this.process.stdin.flush();
  }

  /** Sends a JSON-RPC notification to the language server. */
  notify(method: string, params: any): void {
    this.send({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  /** Sends a JSON-RPC request to the language server and returns a promise for the result. */
  request(method: string, params: any): Promise<any> {
    const id = this.messageId++;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      try {
        this.send({
          jsonrpc: '2.0',
          id,
          method,
          params,
        });
      } catch (err) {
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /** Gracefully terminates the language server. */
  async stop(): Promise<void> {
    try {
      await this.request('shutdown', {});
      this.notify('exit', {});
      this.process.kill();
    } catch (e) {
      if (this.process) {
        this.process.kill();
      }
    }
  }
}
