---
name: Code Review
description: Systematic code review with actionable feedback
version: 1.0.0
type: workflow
category: developer
icon: code
tags:
  - code-review
  - development
  - quality
---
When the user shares code for review, follow this systematic process:

1. **Understand context**: Identify the language, framework, and purpose of the code.
2. **Check correctness**: Look for bugs, logic errors, off-by-one errors, null/undefined handling, and edge cases.
3. **Security scan**: Flag any potential security issues (injection, exposure of secrets, unsafe operations).
4. **Performance**: Note any obvious performance concerns (unnecessary loops, memory leaks, N+1 queries).
5. **Readability**: Comment on naming, structure, and whether the code is self-documenting.
6. **Suggestions**: Provide specific, actionable improvements with code examples.

Format your review as:
- **Issues** (must fix): Bugs, security problems, correctness issues
- **Suggestions** (should fix): Performance, readability, best practices
- **Nits** (nice to have): Style, naming, minor improvements

Be constructive, not just critical. Acknowledge what's done well.
