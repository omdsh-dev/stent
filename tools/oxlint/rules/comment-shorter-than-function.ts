/** Require comments to be shorter than the functions they describe. */

import {
  isDirective,
  isTransparentExpression,
} from '#tools/oxlint/utils/comment-predicates'
import {
  exportedNamesOf,
  isExportDeclaration,
  isExportedNode,
} from '#tools/oxlint/utils/exported-bindings'
import type {
  AstNode,
  Rule,
  RuleContext,
  SourceCode,
  VisitorObject,
} from '#tools/oxlint/utils/function-lines'
import {
  asNode,
  countLines,
  functionName,
} from '#tools/oxlint/utils/function-lines'

const FIRST_INDEX = 0
const SECOND_INDEX = 1
const LAST_INDEX_OFFSET = -1
const MIN_GAP_LINES = 3
const NO_LINES = 0
const ONE_LINE = 1

type CommentToken = ReturnType<SourceCode['getAllComments']>[number]

interface RuleOptions {
  includeAnonymous?: boolean
  includeExported?: boolean
  countCommentDelimiters?: boolean
}
interface FunctionTarget {
  commentAnchor: AstNode
  exported: boolean
}

function exportAnchor(node: AstNode): AstNode | undefined {
  let current = asNode(node.parent)
  while (
    current !== undefined
    && !isExportDeclaration(current)
    && isTransparentExpression(current)
  ) {
    current = asNode(current.parent)
  }
  if (isExportDeclaration(current)) {
    return current
  }
  return undefined
}

function parentTargetFor(
  node: AstNode,
  exportedNames: ReadonlySet<string>,
): FunctionTarget | undefined {
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
      return {
        commentAnchor: exportedAnchor ?? declaration,
        exported:
          exportedAnchor !== undefined
          || isExportedNode(declaration, exportedNames),
      }
    }
  }
  return undefined
}

function functionTarget(
  node: AstNode,
  exportedNames: ReadonlySet<string>,
): FunctionTarget {
  const parentTarget = parentTargetFor(node, exportedNames)
  if (parentTarget !== undefined) {
    return parentTarget
  }
  const exportedAnchor = exportAnchor(node)
  return {
    commentAnchor: exportedAnchor ?? node,
    exported:
      exportedAnchor !== undefined || isExportedNode(node, exportedNames),
  }
}

function hasBlankLine(gap: string): boolean {
  const lines = gap.split(/\r\n|\r|\n/u)
  return (
    lines.length >= MIN_GAP_LINES
    && lines
      .slice(SECOND_INDEX, LAST_INDEX_OFFSET)
      .some((line) => line.trim() === '')
  )
}

function isAdjacent(
  comment: CommentToken,
  nextStart: number,
  source: string,
): boolean {
  const [commentStart, commentEnd] = comment.range
  const gap = source.slice(commentEnd, nextStart)
  if (!/^\s*$/u.test(gap) || hasBlankLine(gap)) {
    return false
  }
  const previousOffset = commentStart + LAST_INDEX_OFFSET
  const newline = source.lastIndexOf('\n', previousOffset)
  const carriageReturn = source.lastIndexOf('\r', previousOffset)
  const lineStartOffset = Math.max(newline, carriageReturn) + ONE_LINE
  return source.slice(lineStartOffset, commentStart).trim() === ''
}

function adjacentCommentsBefore(
  comments: CommentToken[],
  anchorStart: number,
  source: string,
): CommentToken[] {
  const selected: CommentToken[] = []
  let cursor = anchorStart
  for (
    let index = comments.length + LAST_INDEX_OFFSET;
    index >= FIRST_INDEX;
    index -= SECOND_INDEX
  ) {
    const comment = comments[index]
    if (!isAdjacent(comment, cursor, source)) {
      break
    }
    selected.unshift(comment)
    const [commentStart] = comment.range
    cursor = commentStart
  }
  return selected
}

function leadingComments(
  anchor: AstNode,
  sourceCode: SourceCode,
): CommentToken[] {
  const [anchorStart] = anchor.range
  const comments = sourceCode
    .getAllComments()
    .filter((comment) => comment.range[SECOND_INDEX] <= anchorStart)
  return adjacentCommentsBefore(comments, anchorStart, sourceCode.getText())
}

function blockCommentLineCount(lines: readonly string[]): number {
  return lines.filter((line, index) => {
    let content = line.trim()
    if (index === FIRST_INDEX) {
      content = content.replace(/^\/\*+/u, '').trim()
    }
    if (index === lines.length + LAST_INDEX_OFFSET) {
      content = content.replace(/\*\/$/u, '').trim()
    }
    if (/^\*(?:\s|$)/u.test(content)) {
      content = content.slice(SECOND_INDEX).trim()
    }
    return content !== '' && !/^[-_=~*]{3,}$/u.test(content)
  }).length
}

function commentTokenLines(
  comment: CommentToken,
  sourceCode: SourceCode,
  countDelimiters: boolean,
): number {
  if (comment.type === 'Shebang' || isDirective(comment)) {
    return NO_LINES
  }
  const lines = sourceCode.getText(comment).split(/\r\n|\r|\n/u)
  if (countDelimiters) {
    return lines.filter((line) => line.trim() !== '').length
  }
  if (comment.type === 'Line') {
    return Number(
      comment.value.trim() !== ''
        && !/^[-_=~*]{3,}$/u.test(comment.value.trim()),
    )
  }
  return blockCommentLineCount(lines)
}

function commentLineCount(
  comments: readonly CommentToken[],
  sourceCode: SourceCode,
  countDelimiters: boolean,
): number {
  let count = NO_LINES
  for (const comment of comments) {
    count += commentTokenLines(comment, sourceCode, countDelimiters)
  }
  return count
}

function checkNode(
  node: AstNode,
  context: RuleContext,
  options: RuleOptions,
): void {
  const { includeAnonymous = false, includeExported = false } = options
  const target = functionTarget(node, exportedNamesOf(context.sourceCode))
  const name = functionName(node)
  const excluded =
    (name === undefined && !includeAnonymous)
    || (target.exported && !includeExported)
  if (excluded) {
    return
  }
  const commentCount = commentLineCount(
    leadingComments(target.commentAnchor, context.sourceCode),
    context.sourceCode,
    options.countCommentDelimiters ?? false,
  )
  const codeCount = countLines(node, context.sourceCode, {
    skipBlankLines: true,
    skipComments: true,
  })
  if (commentCount >= codeCount && commentCount > NO_LINES) {
    context.report({
      data: {
        code: codeCount,
        comments: commentCount,
        name: name ?? '<anonymous>',
      },
      messageId: 'commentNotShorter',
      node,
    })
  }
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
    const [raw] = context.options
    let options: RuleOptions = {}
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      options = raw
    }
    return {
      FunctionDeclaration: (node) => {
        checkNode(node, context, options)
      },
      FunctionExpression: (node) => {
        checkNode(node, context, options)
      },
      ArrowFunctionExpression: (node) => {
        checkNode(node, context, options)
      },
    }
  },
}
export { commentShorterThanFunction }
