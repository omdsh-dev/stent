/**
 * Require comments to occupy fewer lines than the functions they describe.
 *
 * A comment block that is at least as large as its implementation is usually a
 * signal that the function is unnecessary or too difficult to understand. The
 * rule considers only a contiguous comment block immediately before a function
 * declaration anchor.
 *
 * @module stent/oxlint/rules/comment-shorter-than-function
 */

import type { RuleTester } from 'oxlint/plugins-dev'

import {
  isDirective,
  isTransparentExpression,
} from '../utils/comment-predicates.ts'
import {
  exportedNamesOf,
  isExportDeclaration,
  isExportedNode,
} from '../utils/exported-bindings.ts'
import {
  asNode,
  countLines,
  functionName,
  type AstNode,
  type RuleContext,
  type SourceCode,
} from '../utils/function-lines.ts'

type Rule = Parameters<RuleTester['run']>[1]
type RuleFactory = Extract<Rule, { create: (...args: never[]) => unknown }>
type VisitorObject = ReturnType<RuleFactory['create']>
type CommentTarget = Parameters<SourceCode['getCommentsBefore']>[0]
type CommentToken = ReturnType<SourceCode['getCommentsBefore']>[number]

interface RuleOptions {
  includeAnonymous?: boolean
  includeExported?: boolean
  countCommentDelimiters?: boolean
}

interface FunctionTarget {
  commentAnchor: AstNode
  exported: boolean
}

/** Return an export wrapper around transparent expression syntax, if present. */
function exportAnchor(node: AstNode): AstNode | undefined {
  let current = asNode(node.parent)
  while (current !== undefined) {
    if (isExportDeclaration(current)) {
      return current
    }
    if (!isTransparentExpression(current)) {
      return undefined
    }
    current = asNode(current.parent)
  }
  return undefined
}

/** Find the source anchor whose leading comments document a function. */
function functionTarget(
  node: AstNode,
  exportedNames: ReadonlySet<string>,
): FunctionTarget {
  const parent = asNode(node.parent)
  if (parent?.type === 'MethodDefinition' && asNode(parent.value) === node) {
    return {
      commentAnchor: parent,
      exported: isExportedNode(parent, exportedNames),
    }
  }

  if (parent?.type === 'VariableDeclarator' && asNode(parent.init) === node) {
    const declaration = asNode(parent.parent)
    if (declaration?.type === 'VariableDeclaration') {
      const exportedAnchor = exportAnchor(declaration)
      if (exportedAnchor !== undefined) {
        return { commentAnchor: exportedAnchor, exported: true }
      }
      return {
        commentAnchor: declaration,
        exported: isExportedNode(declaration, exportedNames),
      }
    }
  }

  const exportedAnchor = exportAnchor(node)
  if (exportedAnchor !== undefined) {
    return { commentAnchor: exportedAnchor, exported: true }
  }

  return {
    commentAnchor: node,
    exported: isExportedNode(node, exportedNames),
  }
}

/** Return whether a source gap contains a blank line. */
function hasBlankLine(gap: string): boolean {
  const lines = gap.split(/\r\n|\r|\n/)
  return (
    lines.length > 2 && lines.slice(1, -1).some((line) => line.trim() === '')
  )
}

/** Return the start offset of the source line containing an offset. */
function lineStart(source: string, offset: number): number {
  const newline = source.lastIndexOf('\n', offset - 1)
  const carriageReturn = source.lastIndexOf('\r', offset - 1)
  return Math.max(newline, carriageReturn) + 1
}

/** Return whether a comment starts on a comment-only source line. */
function startsOnCommentLine(comment: CommentToken, source: string): boolean {
  return (
    source.slice(lineStart(source, comment.range[0]), comment.range[0]).trim()
    === ''
  )
}

/** Return whether a comment is directly adjacent to the following source item. */
function isAdjacent(
  comment: CommentToken,
  nextStart: number,
  source: string,
): boolean {
  const gap = source.slice(comment.range[1], nextStart)
  return (
    /^\s*$/.test(gap)
    && !hasBlankLine(gap)
    && startsOnCommentLine(comment, source)
  )
}

/** Collect the contiguous comment block directly before a function anchor. */
function leadingComments(
  node: AstNode,
  sourceCode: SourceCode,
): CommentToken[] {
  const source = sourceCode.getText()
  const comments = sourceCode.getCommentsBefore(
    node as unknown as CommentTarget,
  )
  const selected: CommentToken[] = []
  let nextStart = node.range[0]

  for (let index = comments.length - 1; index >= 0; index--) {
    const comment = comments[index]
    if (!isAdjacent(comment, nextStart, source)) {
      break
    }
    selected.unshift(comment)
    nextStart = comment.range[0]
  }
  return selected
}

/** Remove a block comment's delimiters and JSDoc decoration from one line. */
function documentationLine(
  line: string,
  first: boolean,
  last: boolean,
): string {
  let content = line.trim()
  if (first) {
    content = content.replace(/^\/\*+/, '').trim()
  }
  if (last) {
    content = content.replace(/\*\/$/, '').trim()
  }
  if (/^\*(?:\s|$)/.test(content)) {
    content = content.slice(1).trim()
  }
  return content
}

/** Return whether a documentation line is meaningful rather than a divider. */
function isMeaningfulDocumentation(content: string): boolean {
  if (content === '') {
    return false
  }
  return !/^[-_=~*]{3,}$/.test(content)
}

/** Count meaningful documentation lines in one comment token. */
function commentTokenLines(
  comment: CommentToken,
  sourceCode: SourceCode,
  countDelimiters: boolean,
): number {
  if (comment.type === 'Shebang' || isDirective(comment)) {
    return 0
  }
  const text = sourceCode.getText(comment)
  const lines = text.split(/\r\n|\r|\n/)
  if (countDelimiters) {
    return lines.filter((line) => line.trim() !== '').length
  }
  if (comment.type === 'Line') {
    if (isMeaningfulDocumentation(comment.value.trim())) {
      return 1
    }
    return 0
  }
  return lines.filter((line, index) => {
    const content = documentationLine(
      line,
      index === 0,
      index === lines.length - 1,
    )
    return isMeaningfulDocumentation(content)
  }).length
}

/** Count meaningful lines in a contiguous leading comment block. */
function commentLineCount(
  comments: readonly CommentToken[],
  sourceCode: SourceCode,
  countDelimiters: boolean,
): number {
  let count = 0
  for (const comment of comments) {
    count += commentTokenLines(comment, sourceCode, countDelimiters)
  }
  return count
}

function isRuleOptions(value: unknown): value is RuleOptions {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return !Array.isArray(value)
}

const commentShorterThanFunction: Rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require comments before a function to be shorter than its implementation',
    },
    schema: [
      {
        type: 'object',
        properties: {
          includeAnonymous: { type: 'boolean' },
          includeExported: { type: 'boolean' },
          countCommentDelimiters: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      commentNotShorter:
        '{{name}} has {{comments}} associated comment lines but only {{code}} effective function lines; comments must be shorter than the function.',
    },
  },

  create(context: RuleContext): VisitorObject {
    const raw = context.options[0]
    let options: RuleOptions
    if (isRuleOptions(raw)) {
      options = raw
    } else {
      options = {}
    }
    const includeAnonymous = options.includeAnonymous ?? false
    const includeExported = options.includeExported ?? false
    const countDelimiters = options.countCommentDelimiters ?? false
    const exportedNames = exportedNamesOf(context.sourceCode)

    function check(node: AstNode): void {
      const target = functionTarget(node, exportedNames)
      if (target.exported && !includeExported) {
        return
      }
      const name = functionName(node)
      if (name === undefined && !includeAnonymous) {
        return
      }
      const comments = leadingComments(target.commentAnchor, context.sourceCode)
      const commentCount = commentLineCount(
        comments,
        context.sourceCode,
        countDelimiters,
      )
      if (commentCount === 0) {
        return
      }
      const codeCount = countLines(node, context.sourceCode, {
        skipBlankLines: true,
        skipComments: true,
      })
      if (commentCount < codeCount) {
        return
      }
      context.report({
        node,
        messageId: 'commentNotShorter',
        data: {
          name: name ?? '<anonymous>',
          comments: commentCount,
          code: codeCount,
        },
      })
    }

    return {
      FunctionDeclaration(node) {
        check(node)
      },
      FunctionExpression(node) {
        check(node)
      },
      ArrowFunctionExpression(node) {
        check(node)
      },
    }
  },
}
export { commentShorterThanFunction }
