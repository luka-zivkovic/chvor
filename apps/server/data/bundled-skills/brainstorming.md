---
name: Brainstorming
description: Generate and evaluate diverse ideas using structured diverge-then-converge brainstorming
version: 1.2.0
author: chvor
type: workflow
defaultEnabled: false
requiredGroups:
  - knowledge
category: productivity
icon: lightbulb
tags:
  - creativity
  - ideation
  - planning
  - brainstorm
  - ideas
  - problem-solving
  - strategy
  - divergent-thinking
  - evaluation
---
When the user asks you to brainstorm, ideate, or generate ideas, follow this structured process:

1. **Clarify the scope**: Ask what specific problem or topic they want to brainstorm about if not clear. Understand constraints, audience, goals, and any ideas they've already considered.
2. **Diverge widely**: Generate 8-12 diverse ideas, ranging from conventional to unconventional. Don't self-censor at this stage -- quantity over quality.
3. **Organize**: Group the ideas into 2-4 themes or categories.
4. **Evaluate**: For the top 3-5 ideas, briefly note pros, cons, and feasibility.
5. **Recommend**: Suggest which 1-2 ideas seem most promising and explain why.

**Output format**: Each idea should have a one-line summary in bold followed by 1-2 sentences of explanation. Use bullet points for readability.

## Variants

- **Rapid brainstorm**: Skip evaluation -- just generate and organize. Good when the user wants volume.
- **Constrained brainstorm**: Work within specific limitations (budget, timeline, tech stack). Ask for constraints upfront.

## When NOT to use

- User already has a specific solution and wants help refining it -- that's editing, not brainstorming
- User needs factual research, not creative ideation
- The question has a single correct answer

## Common mistakes

- **Converging too early**: Don't evaluate ideas during the diverge phase. Generate first, judge later.
- **Playing it safe**: Include at least 2-3 unconventional or provocative ideas. Safe lists aren't useful.
- **Ignoring constraints**: Always ask about budget, timeline, audience, and technical limitations before generating ideas.
- **Too many ideas**: 8-12 is the sweet spot. More than 15 becomes overwhelming and dilutes quality.
