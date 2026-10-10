/**
 * Prefix on every tool result that means "the index could not locate it".
 * Clients (e.g. agentic_acp_server's `indexerFirst` hook) look for it in the
 * tool output to let an agent fall back to raw file reads/searches. Keep it
 * stable: it is a cross-repo contract.
 */
export const NO_RESULTS_MARKER = '[no-results]'

/**
 * A tool result for a lookup that found nothing. Analysis answers that are
 * legitimately empty (e.g. "no circular dependencies") should not use it.
 */
export function noResults(text: string) {
  return {
    content: [{ type: 'text' as const, text: `${NO_RESULTS_MARKER} ${text}` }],
    _meta: { 'agentic/noResults': true },
  }
}
