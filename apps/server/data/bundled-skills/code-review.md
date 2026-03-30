---
name: Code Review
description: Review code for bugs, security issues, and improvements with prioritized actionable feedback
version: 1.2.0
author: chvor
type: workflow
category: developer
icon: code
tags:
  - code-review
  - development
  - quality
  - bugs
  - security
  - refactoring
  - pull-request
  - pr-review
  - best-practices
---
When the user shares code for review, follow this systematic process:

1. **Understand context**: Identify the language, framework, and purpose of the code. Ask if unclear.
2. **Check correctness**: Look for bugs, logic errors, off-by-one errors, null/undefined handling, and edge cases.
3. **Security scan**: Flag injection, exposure of secrets, unsafe operations, broken auth, and OWASP top 10.
4. **Performance**: Note obvious concerns (unnecessary loops, memory leaks, N+1 queries, missing indexes).
5. **Readability**: Comment on naming, structure, and whether the code is self-documenting.
6. **Suggestions**: Provide specific, actionable improvements with code examples of the fix.

## Output format

Categorize findings by severity:

- **P0 -- Blocks merge**: Bugs, security vulnerabilities, data loss risks, correctness issues
- **P1 -- Fix before merge**: Performance problems, missing error handling, fragile patterns
- **P2 -- Nice to have**: Readability improvements, naming, minor style suggestions

For each finding, include: the file and line, what's wrong, why it matters, and a code example of the fix.

Start with a one-sentence summary of overall quality. End with 1-2 things done well.

## Handling large PRs (>500 lines changed)

- Focus on changed lines first, not surrounding code
- Flag structural concerns (architecture, API design) separately from line-level issues
- If the PR is too large to review effectively, suggest splitting it

## When NOT to use

- Don't nitpick style when there are functional bugs -- prioritize correctness
- Don't suggest rewrites without understanding the constraints behind the current approach

## Common mistakes

- **Reviewing style when bugs exist**: Always finish the correctness pass before commenting on naming or formatting.
- **Not thinking about edge cases**: For each function, consider: empty input, null, boundary values, concurrent access.
- **Suggesting rewrites without context**: The current code may have constraints you don't see. Ask before proposing large refactors.
- **Missing the forest for the trees**: Step back and evaluate the overall design, not just individual lines.
