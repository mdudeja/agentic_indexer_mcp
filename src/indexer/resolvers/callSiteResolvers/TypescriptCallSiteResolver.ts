import type { Node } from 'web-tree-sitter'
import type {
  CallSiteResolver,
  CallSiteResolverWithStaticMethod,
  ResolvedCallSite,
} from './CallSiteResolver'
import { CallKind } from 'src/database/schemas/call_sites.schema'
import { removeWrappingParenthesis } from '.'
import { ImplementsStatic } from 'src/utils/ImplementsStaticDecorator'

@ImplementsStatic<CallSiteResolverWithStaticMethod>()
/** A utility for resolving call sites within TypeScript code, enabling identification of where function calls originate from. */
export class TypescriptCallSiteResolver implements CallSiteResolver {
  private static readonly methodCallSplitterRegex = /(?:\!|\?)?(?:\.)/
  private readonly defaultValueRegex = /\s*(\?\?|\|\|)\s*[^)]+/
  private readonly aliasRegex = /\s+as\s+\w+/

  /** Resolve the call site for a given name within an AST node. */
  resolve(node: Node, capturedName: string): ResolvedCallSite | null {
    let callExprNode: Node | null = node.parent
    while (
      callExprNode &&
      !['call_expression', 'new_expression'].includes(callExprNode.type)
    ) {
      callExprNode = callExprNode.parent
    }

    callExprNode = callExprNode ?? node
    const isParentDecorator = callExprNode.parent?.type === 'decorator'

    const call_text = callExprNode.text
    const callee_expression =
      (capturedName === 'call.constructor'
        ? (callExprNode.childForFieldName('constructor')?.text ?? '')
        : callExprNode.childForFieldName('function')?.text) ?? ''
    const call_kind = isParentDecorator
      ? CallKind.DecoratorCall
      : this.convertCapturedNameToCallKind(capturedName, callee_expression)
    const callee_name = this.getCalleeName(callExprNode, call_kind)

    if (!callee_name) {
      return null
    }

    let callee_base: string | undefined, callee_property: string | undefined
    if (call_kind === CallKind.MethodCall) {
      const calleeBaseAndProperty =
        this.getCalleeBaseAndProperty(callee_expression)
      callee_base = calleeBaseAndProperty.callee_base
      callee_property = calleeBaseAndProperty.callee_property
    }

    return {
      call_text,
      callee_expression: callee_expression.replace(/^\s+|\s+$/g, ''),
      call_kind,
      callee_name,
      callee_base,
      callee_property,
      call_line: node.startPosition.row + 1,
      call_column: node.startPosition.column + 1,
      end_line: node.endPosition.row + 1,
      end_column: node.endPosition.column + 1,
    }
  }

  /** This method parses a function call expression and returns an array of its constituent parts. */
  static getPartsOfCalleeExpression(callee_expression: string): string[] {
    return callee_expression
      .replace(/\n(\s)+/g, '')
      .split(this.methodCallSplitterRegex)
      .map((part) => part.trim())
  }

  /** Converts a captured function or method name into the corresponding CallKind. */
  private convertCapturedNameToCallKind(
    capturedName: string,
    callee_expression: string,
  ): CallKind {
    switch (capturedName) {
      case 'call.identifier':
        return CallKind.FunctionCall
      case 'call.member':
        return CallKind.MethodCall
      case 'call.constructor':
        return CallKind.ConstructorCall
      case 'call.dynamic':
        return CallKind.DynamicCall
      default:
        if (callee_expression === 'super') {
          return CallKind.SuperCall
        }
        return CallKind.Unknown
    }
  }

  /** Retrieves the name of the function or method being called. */
  private getCalleeName(node: Node, callKind: CallKind): string | undefined {
    switch (callKind) {
      case CallKind.FunctionCall:
        return node.childForFieldName('function')?.text
      case CallKind.MethodCall:
        return node.childForFieldName('function')?.childForFieldName('property')
          ?.text
      case CallKind.ConstructorCall:
        return node.childForFieldName('constructor')?.text ?? ''
      case CallKind.DecoratorCall:
        const fnNode = node.childForFieldName('function')
        if (!fnNode) return undefined
        const fnNodeType = fnNode.type
        if (fnNodeType === 'identifier') {
          return this.getCalleeName(node, CallKind.FunctionCall)
        }
        if (fnNodeType === 'member_expression') {
          return this.getCalleeName(node, CallKind.MethodCall)
        }
        return undefined
      case CallKind.SuperCall:
        return 'super'
      case CallKind.DynamicCall:
        const dynamicNode = node.parent?.childForFieldName('function')
        if (!dynamicNode) return undefined
        return dynamicNode.childForFieldName('index')?.text
      default:
        return undefined
    }
  }

  /** Parses a function or method call expression to extract the base object and the called property. */
  private getCalleeBaseAndProperty(callee_expression: string): {
    callee_base: string | undefined
    callee_property: string | undefined
  } {
    let parenRemovalAttempts = 0

    const parts =
      TypescriptCallSiteResolver.getPartsOfCalleeExpression(callee_expression)
    let callee_base = parts
      .slice(0, -1)
      .join('.')
      .replace(this.aliasRegex, '')
      .replace(this.defaultValueRegex, '')
      .trim()
    const callee_property = parts[parts.length - 1]?.trim()

    while (
      callee_base.startsWith('(') &&
      callee_base.endsWith(')') &&
      parenRemovalAttempts < 5
    ) {
      callee_base = removeWrappingParenthesis(callee_base)
      parenRemovalAttempts++
    }

    return { callee_base, callee_property }
  }
}
