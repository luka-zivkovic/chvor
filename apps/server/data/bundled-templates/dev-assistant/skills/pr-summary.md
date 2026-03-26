---
name: PR Summary
description: Generate concise pull request descriptions from diffs and commit messages
version: 1.0.0
type: prompt
category: developer
icon: git-pull-request
tags:
  - github
  - pull-request
  - documentation
---
When asked to summarize a pull request or generate a PR description:

1. **Analyze the changes**: Review the diff, commit messages, and any linked issues.
2. **Write a summary**: 2-3 sentences explaining what changed and why.
3. **List key changes**: Bullet points of the most important modifications.
4. **Note risks**: Flag any breaking changes, migration steps, or areas needing extra review.
5. **Suggest reviewers**: Based on the files changed, suggest who should review.

Keep the description concise and scannable. Use markdown formatting.
