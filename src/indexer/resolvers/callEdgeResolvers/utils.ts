import { CallResolutionSource } from 'src/database/schemas'

/** Calculates the confidence level based on the specified call resolution source. */
export function getConfidenceByCallResolutionSource(
  resolutionSource: CallResolutionSource,
): number {
  switch (resolutionSource) {
    case CallResolutionSource.LspDefinition:
      return 100
    case CallResolutionSource.SourceImport:
      return 90
    case CallResolutionSource.SameFile:
      return 80
    case CallResolutionSource.SameClass:
      return 75
    case CallResolutionSource.ExternalImport:
      return 70
    case CallResolutionSource.LspHover:
      return 60
    case CallResolutionSource.BuiltinList:
      return 50
    case CallResolutionSource.DynamicPattern:
      return 20
    case CallResolutionSource.Unresolved:
      return 50
    default:
      return 0
  }
}

/** Processes an array of imported names to extract or organize them, considering whether only types should be included. */
export function processImportedNames(
  importedNames: string[],
  includeTypeOnly?: boolean,
): string[] {
  if (!importedNames || importedNames.length === 0) {
    return []
  }

  const processedNames: string[] = []

  for (const name of importedNames) {
    // Remove any leading or trailing whitespace
    const trimmedName = name.trim()
    let toPushName: string | undefined

    // Skip empty names
    if (trimmedName.length === 0) {
      continue
    }

    // if name starts with type, skip the name unless includeTypeOnly is true, in which case we strip the type prefix and include it
    if (trimmedName.startsWith('type ')) {
      if (includeTypeOnly) {
        toPushName = trimmedName.replace(/^type\s+/, '').trim()
      } else {
        continue
      }
    }

    // if name has `as `, split and take the first part
    toPushName = (toPushName || trimmedName).replace(/\s+as\s+.*$/, '').trim()

    // Add the processed name to the result array
    processedNames.push(toPushName)
  }

  return processedNames
}
