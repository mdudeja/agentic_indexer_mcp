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
/** A utility class for identifying the call site of a Python function, useful for debugging and analysis purposes. */
export class PythonCallSiteResolver implements CallSiteResolver {
  private static readonly methodCallSplitterRegex = /(?:\.)/
  private readonly defaultValueRegex = /\s+or\s+\w+/

  /** Resolve where a specific name was captured within the context of the given node. Returns the resolved call site if found, or null if not found. */
  resolve(node: Node, capturedName: string): ResolvedCallSite | null {
    let callExprNode: Node | null = node.parent

    while (callExprNode && callExprNode.type !== 'call') {
      callExprNode = callExprNode.parent
    }

    callExprNode = callExprNode ?? node
    const isParentDecorator = callExprNode.parent?.type === 'decorator'

    const call_text = callExprNode.text
    const callee_expression =
      capturedName === 'call.dynamicgetattr'
        ? callExprNode.text
        : (callExprNode.childForFieldName('function')?.text ?? '')
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

  /** Parses a given callee expression and returns its constituent parts as an array. */
  static getPartsOfCalleeExpression(callee_expression: string): string[] {
    return callee_expression
      .replace(/\n(\s)+/g, '')
      .split(this.methodCallSplitterRegex)
  }

  /** Converts a captured name and callee expression to determine the kind of call being made. */
  private convertCapturedNameToCallKind(
    capturedName: string,
    callee_expression: string,
  ): CallKind {
    switch (capturedName) {
      case 'call.identifier':
        return CallKind.FunctionCall
      case 'call.member':
        return CallKind.MethodCall
      case 'call.dynamicgetattr':
        return CallKind.DynamicCall
      case 'call.dynamic':
        return CallKind.DynamicCall
      default:
        if (callee_expression === 'super') {
          return CallKind.SuperCall
        }
        return CallKind.Unknown
    }
  }

  /** Retrieves the name of the function or method being called based on the provided node and call kind. */
  private getCalleeName(node: Node, callKind: CallKind): string | undefined {
    switch (callKind) {
      case CallKind.FunctionCall:
        return node.childForFieldName('function')?.text
      case CallKind.MethodCall:
        return node
          .childForFieldName('function')
          ?.childForFieldName('attribute')?.text
      case CallKind.DecoratorCall:
        const fnNode = node.childForFieldName('function')
        if (!fnNode) return undefined
        const fnNodeType = fnNode.type
        if (fnNodeType === 'identifier') {
          return this.getCalleeName(node, CallKind.FunctionCall)
        }
        if (fnNodeType === 'attribute') {
          return this.getCalleeName(node, CallKind.MethodCall)
        }
        return undefined
      case CallKind.SuperCall:
        return 'super'
      case CallKind.DynamicCall:
        const fn = node.childForFieldName('function')
        if (!fn) return undefined
        return fn.childForFieldName('subscript')?.text
      case CallKind.ConstructorCall:
        return node.childForFieldName('function')?.text
      default:
        return undefined
    }
  }

  /** Parse a call expression to identify its base and property components. */
  private getCalleeBaseAndProperty(callee_expression: string): {
    callee_base: string | undefined
    callee_property: string | undefined
  } {
    let parentRemovalAttempts = 0

    const parts =
      PythonCallSiteResolver.getPartsOfCalleeExpression(callee_expression)

    let callee_base = parts
      .slice(0, -1)
      .join('.')
      .replace(this.defaultValueRegex, '')
      .trim()
    const callee_property = parts[parts.length - 1]?.trim()

    while (
      callee_base.startsWith('(') &&
      callee_base.endsWith(')') &&
      parentRemovalAttempts < 5
    ) {
      callee_base = removeWrappingParenthesis(callee_base)
      parentRemovalAttempts++
    }

    return { callee_base, callee_property }
  }
}
