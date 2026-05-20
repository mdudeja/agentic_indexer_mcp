/** Truncates a string to the specified maximum length and appends an ellipsis if the string exceeds that length. */
export function truncate(s: string, max_length: number): string {
  return s.length > max_length ? s.slice(0, max_length - 1) + '…' : s
}
