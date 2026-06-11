import { readFileSync } from 'fs';
import { Enhancer } from '../steps/s2_Enhancer.ts';
import { LspClient } from '../../utils/LspClient.ts';
import { logError } from 'src/utils/logger.ts';

/** Enhancer implementation that connects to standard Language Servers (like Pyright or gopls) for runtime type queries. */
export class GenericLspEnhancer extends Enhancer {
  private client: LspClient | null = null;
  private openDocuments = new Set<string>();

  constructor(
    cwd: string,
    private lspBinaryPath: string,
    private languageId: string
  ) {
    super(cwd);
  }

  override async init(): Promise<boolean> {
    if (this.initialized) return this.available;
    this.initialized = true;

    try {
      this.client = new LspClient(this.lspBinaryPath, this.cwd);
      await this.client.start();
      this.available = true;
    } catch (err) {
      logError(`[LSP Enhancer - ${this.languageId}] Failed to initialize LSP client:`, err);
      this.available = false;
    }

    return this.available;
  }

  private ensureFileOpen(absPath: string): void {
    if (!this.client || this.openDocuments.has(absPath)) return;

    try {
      const text = readFileSync(absPath, 'utf8');
      this.client.notify('textDocument/didOpen', {
        textDocument: {
          uri: `file://${absPath}`,
          languageId: this.languageId,
          version: 1,
          text,
        },
      });
      this.openDocuments.add(absPath);
    } catch (err) {
      logError(`[LSP Enhancer - ${this.languageId}] Failed to open document:`, err);
    }
  }

  override async getTypeAtLocation(
    absPath: string,
    line: number,
    column: number
  ): Promise<string | null> {
    if (!this.available || !this.client) return null;

    this.ensureFileOpen(absPath);

    try {
      const response = await this.client.request('textDocument/hover', {
        textDocument: {
          uri: `file://${absPath}`,
        },
        position: {
          line,
          character: column,
        },
      });

      if (!response || !response.contents) return null;

      const contents = response.contents;

      // Extract markdown/plaintext content from different hover payload structures
      if (typeof contents === 'string') {
        return contents;
      }
      if (Array.isArray(contents)) {
        return contents
          .map((c) => (typeof c === 'string' ? c : c.value))
          .join('\n');
      }
      if (contents.value) {
        return contents.value;
      }
      return null;
    } catch (err) {
      logError(`[LSP Enhancer - ${this.languageId}] Hover request failed:`, err);
      return null;
    }
  }

  override refreshFile(absPath: string): void {
    if (!this.client || !this.openDocuments.has(absPath)) return;

    try {
      const text = readFileSync(absPath, 'utf8');
      this.client.notify('textDocument/didChange', {
        textDocument: {
          uri: `file://${absPath}`,
          version: Date.now(),
        },
        contentChanges: [{ text }],
      });
    } catch (err) {
      logError(`[LSP Enhancer - ${this.languageId}] Failed to notify file changes:`, err);
    }
  }

  // LSP enhancers are mainly used for live type query hovers, indexing-time analysis is not yet handled.
  override async enhanceSymbolTypesForCallables(): Promise<void> {}
  override async enhanceSymbolTypesForInheritedTypesAndInterfaces(): Promise<void> {}
  override async resolveAllPendingCalls(): Promise<void> {}

  /** Stops the background LSP process when disposing resources. */
  async dispose(): Promise<void> {
    if (this.client) {
      await this.client.stop();
    }
  }
}
