import type { IndexedSymbol } from 'src/database/schemas'

const hasher = new Bun.CryptoHasher('sha256')

/** "Computes the cryptographic hash of file content." */
export function hashFileContent(content: string): string {
  hasher.update(content)
  return hasher.digest('hex')
}

/** Generates a unique hex-encoded hash based on the symbol's attributes for identification purposes. */
export function hashSymbol(symbol: IndexedSymbol['Update']): string {
  hasher.update(symbol.name!)
  hasher.update(symbol.kind!)
  hasher.update(symbol.file_path!)
  hasher.update(symbol.line!.toString())
  hasher.update(symbol.column!.toString())
  hasher.update(symbol.signature!)
  return hasher.digest('hex')
}
