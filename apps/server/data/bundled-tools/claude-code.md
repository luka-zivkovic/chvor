---
name: Claude Code
description: Delegate complex multi-file coding tasks to the Claude Code CLI agent
version: 1.2.0
author: chvor
type: tool
category: developer
icon: terminal
tags:
  - coding
  - refactoring
  - debugging
  - testing
  - cli
  - agent
  - multi-file
  - scaffold
  - git
---
You have access to Claude Code via `native__claude_code`. This is a powerful coding agent that can read, write, and refactor code across entire projects.

## When to use

- **Multi-file edits** -- refactoring, renaming across a codebase, updating imports
- **Debugging** -- investigating and fixing bugs that span multiple files
- **Writing tests** -- generating test suites for existing code
- **Codebase exploration** -- understanding unfamiliar projects, tracing execution paths
- **Complex git operations** -- interactive rebases, merge conflict resolution, cherry-picks
- **Scaffolding** -- generating boilerplate, new modules, or project structures

## When NOT to use

- Simple questions you can answer directly
- Single-line code changes
- Non-coding tasks (web search, file downloads, scheduling)

## How to use

Call `native__claude_code` with:

- **prompt** (required): Be specific. Include file paths, expected behavior, and constraints.
  - Good: "In src/lib/auth.ts, refactor the login function to use async/await instead of callbacks. Keep the same public API."
  - Bad: "Fix the auth code"
- **workingDir** (required in practice): Always set this to the project root directory.
- **maxTurns** (optional): Limit agentic turns (default 10, max 50). Increase for complex tasks.

## Auth recovery

If `native__claude_code` returns an authentication error:

1. Call `native__claude_code` with `action: "login"` -- this returns an auth URL
2. Open the URL with `native__browser_navigate`
3. Look up the user's Anthropic account credentials: call `native__list_credentials` and find a credential of type `account` with a name like "Anthropic Account"
4. Use `native__browser_act` to enter the email, then the password, then submit the login form
5. Use `native__browser_act` to approve the OAuth consent if prompted
6. Once login completes, retry your original coding task with `native__claude_code`

If no Anthropic account credential exists, ask the user for their email and password, then save it:
```
native__add_credential(name: "Anthropic Account", type: "account", data: { email: "...", password: "..." })
```

## Tips

- One logical change per invocation -- Claude Code works best with clear, scoped tasks
- For large refactors, break into steps and call Claude Code multiple times
- Always review the result before presenting it to the user
- If a task times out, break it into smaller pieces or increase `maxTurns`
