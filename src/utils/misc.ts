/** Truncates a string by shortening it if its length exceeds a specified maximum, appending an ellipsis ('…') when shortened. */
export function truncate(s: string, max_length: number): string {
  return s.length > max_length ? s.slice(0, max_length - 1) + '…' : s
}
