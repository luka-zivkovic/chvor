# Inspiration Projects for Chvor

> Research snapshot: July 2026

## Executive recommendation

Chvor should not become another generic agent framework or low-code workflow builder. Its strongest position is as an **inspectable, persistent, safe personal-agent control plane**:

- Pi provides the generic agent runtime.
- Chvor owns identity, memory, channels, permissions, credentials, integrations, durable execution, and visualization.
- Proven ideas from adjacent projects improve each of those product layers.

The most useful synthesis is:

> Pi's engine + Letta's memory model + LangGraph's execution history + Home Assistant's integration lifecycle + n8n's debugging UX + Langfuse's evaluation loop + MCP Apps as the interactive UI standard.

## Priority map

| Project                                                               | Primary lesson for Chvor                                            | Priority |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- | -------: |
| [Letta](https://docs.letta.com/)                                      | Structured persistent memory and context budgeting                  |  Highest |
| [LangGraph](https://docs.langchain.com/oss/python/langgraph/overview) | Checkpoints, replay, fork, and resumable approvals                  |  Highest |
| [Home Assistant](https://developers.home-assistant.io/)               | Integration setup, reauthentication, migrations, and quality levels |  Highest |
| [n8n](https://docs.n8n.io/)                                           | Per-step execution inspection and integration contracts             |     High |
| [Langfuse](https://langfuse.com/)                                     | Tracing, production datasets, evaluations, and experiments          |     High |
| [Goose](https://block.github.io/goose/)                               | Recipes, MCP ecosystem, subagents, and extension UX                 |     High |
| [OpenHands](https://docs.openhands.dev/)                              | Sandbox/runtime boundaries and event architecture                   |   Medium |
| [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)  | Standard interactive tool interfaces                                |     High |
| [Open WebUI](https://docs.openwebui.com/)                             | Model/persona/knowledge/tool composition UX                         |   Medium |
| [Temporal](https://docs.temporal.io/)                                 | Durable long-running execution semantics                            |   Future |

## 1. Letta: make memory understandable

Letta's most useful insight is that not every memory should depend on semantic retrieval. It separates always-visible structured memory, recent conversation, summarized history, searchable files, archival memory, and external RAG.

Chvor already has graph memory, activation, decay, emotion, and retrieval. It should add a simpler and more explicit context hierarchy:

```text
Identity memory
  Stable agent identity and rules

Human memory
  User preferences, relationships, and important facts

Working memory
  Active goals, unresolved tasks, and current projects

Procedural memory
  Lessons about tools, integrations, and successful behavior

Episodic memory
  Past events and conversations

Knowledge memory
  Documents and imported information
```

Each memory block should expose:

- Why it is currently in context
- Who created or changed it
- Confidence and provenance
- Last verification date
- Character or token budget
- Read-only versus agent-editable status
- Complete revision history

The user should be able to inspect and correct what the agent currently believes. See [Letta memory blocks](https://docs.letta.com/guides/core-concepts/memory/memory-blocks) and [Letta's context hierarchy](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy).

## 2. LangGraph: make the canvas a time machine

Chvor's canvas currently emphasizes live visualization. The next step is a durable execution debugger inspired by LangGraph's checkpoint, replay, fork, and interrupt model.

Users should be able to:

- Click any past reasoning or tool step
- Inspect its input, output, duration, model, token usage, and cost
- Retry from that step
- Edit an input and fork an alternative execution
- Resume an interrupted approval after restarting the server
- Compare execution branches
- Promote a successful branch into a reusable automation
- See why a different model or tool was selected

This would turn the brain canvas into **Git-style history for agent behavior**, rather than an ephemeral animation. See [LangGraph time travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel).

If Pi becomes Chvor's engine, LangGraph should remain an inspiration for persistence and UX rather than becoming a second agent engine.

## 3. Home Assistant: create a trustworthy integration ecosystem

Home Assistant has spent years solving a problem close to Chvor's: supporting many third-party integrations with different authentication, discovery, configuration, failure, and maintenance behavior in a local-first product.

Chvor should borrow:

- Declarative integration manifests
- UI-driven configuration flows
- Discovery followed by user confirmation
- Shared OAuth infrastructure
- Reauthentication for expired or revoked credentials
- Versioned configuration migrations
- Explicit integration ownership
- Repair notifications and diagnostic exports
- A formal integration quality scale

### Proposed Chvor integration quality scale

```text
Experimental
  Tool exists and basic execution works

Bronze
  Typed schemas, credential setup, basic tests

Silver
  Token refresh, retries, redaction, diagnostics

Gold
  Reauthentication, pagination, rate-limit handling,
  idempotency, and integration tests

Platinum
  Sandboxed, observable, documented, maintained,
  backup-safe, and migration-safe
```

Every integration card should display its quality level and requested capabilities. This makes the registry communicate trust, not merely availability.

Relevant references:

- [Home Assistant integration quality scale](https://developers.home-assistant.io/docs/core/integration-quality-scale/)
- [Home Assistant configuration flows](https://developers.home-assistant.io/docs/core/integration/config_flow/)
- [Home Assistant application credentials](https://developers.home-assistant.io/docs/core/platform/application_credentials/)

## 4. n8n: borrow execution debugging, not the product identity

n8n is most useful as an operational UX reference. Chvor should borrow:

- Stable node input and output contracts
- Inspection of data after every step
- Pinning representative sample data
- Retrying one failed step
- Running one tool manually
- Separation of editor state from execution state
- Credential references rather than embedded secrets
- Execution retention policies
- Integration-specific parameter editors

Every Chvor tool call should expose:

```text
Input
Output
Redacted credential used
Model decision
Approval record
Duration
Retries
Cost
Error classification
Re-run
Save as evaluation case
```

A particularly valuable action would be **Save this execution as a regression test**.

Chvor should not become a manually assembled deterministic workflow editor. The agent should continue planning dynamically; n8n is inspiration for debugging discipline.

## 5. Langfuse: build an agent improvement loop

Code tests do not establish that agent behavior is improving. Langfuse demonstrates how to connect traces, evaluations, datasets, prompt versions, experiments, cost, latency, and human scoring.

Chvor should provide a lightweight local improvement loop:

1. Record every complete agent trajectory.
2. Let the user classify it as good, bad, unsafe, incomplete, or wasteful.
3. Convert failures into permanent evaluation cases.
4. Replay cases against a new engine, model, prompt, memory policy, or tool description.
5. Compare completion rate, cost, latency, approval count, and unsafe actions.
6. Prevent releases when critical scenarios regress.

Useful built-in evaluations include:

- Did the agent complete the requested outcome?
- Did it use the correct credential?
- Did it request approval at the right moment?
- Did it expose sensitive information?
- Did it make unnecessary tool calls?
- Did memory improve or harm the answer?
- Did it recover after a tool failure?
- Did it stop correctly when blocked?

See [Langfuse](https://langfuse.com/) and [Langfuse datasets](https://langfuse.com/docs/evaluation/experiments/datasets).

## 6. Goose: improve recipes, extensions, and delegation

Goose is a close conceptual neighbor: local, general-purpose, multi-model, MCP-centric, and available through desktop, CLI, and API surfaces.

### Recipes

Goose recipes package instructions, parameters, tools, and subrecipes into portable configurations. Chvor templates could become launchable agent recipes:

```yaml
name: Weekly project review

inputs:
  project:
    type: string

needs:
  - github
  - slack

schedule:
  suggested: "0 9 * * MON"

permissions:
  github: read
  slack: draft

instructions:
  - Review merged pull requests
  - Identify blocked work
  - Draft, but do not send, the Slack update
```

Before installation, the UI should validate credentials, permissions, channels, models, and runtime requirements.

### Extension trust

Every extension should show:

- Publisher and source
- Requested capabilities
- Network and filesystem access
- Credential types
- Security scan status
- Last update
- Quality tier

### Subagents

Chvor's multi-mind system can use the same simple mental model as Goose: visible delegated branches with explicit scopes, separate context, and a final merge.

References:

- [Goose](https://block.github.io/goose/)
- [Goose recipes](https://goose-docs.ai/docs/guides/recipes/)
- [Goose extensions](https://goose-docs.ai/docs/mcp/filesystem-mcp/)

## 7. OpenHands: separate the agent from its execution environment

OpenHands treats execution as a distinct runtime behind an interface. Chvor should formalize the same boundary:

```ts
interface ExecutionRuntime {
  execute(command: Command): Promise<ExecutionResult>;
  readFile(path: string): Promise<FileResult>;
  openPort(port: number): Promise<RuntimeUrl>;
  snapshot(): Promise<RuntimeSnapshot>;
  dispose(): Promise<void>;
}
```

Possible implementations:

- Local process runtime
- Docker runtime
- Remote PC-agent runtime
- Browser runtime
- Future microVM runtime

This keeps security policy out of individual tools and makes execution behavior consistent. See [OpenHands runtime architecture](https://docs.openhands.dev/openhands/usage/architecture/runtime).

## 8. MCP Apps: standardize interactive tool output

Chvor already has A2UI support, but MCP Apps now provides a standard mechanism for tools to return interactive interfaces rendered by a host.

Chvor should support MCP Apps as first-class chat and canvas nodes for:

- Forms
- Approval interfaces
- Interactive charts
- Maps
- Data tables
- Configuration wizards
- Preview-and-confirm screens

The host should sandbox each interface, mediate its actions, and associate every interaction with its originating tool call.

Keep Chvor's proprietary A2UI only for capabilities MCP Apps cannot express, or provide an A2UI compatibility adapter. See the [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview).

## 9. Open WebUI: simplify brain composition

Open WebUI lets users compose an AI from understandable building blocks: models, knowledge, prompts, skills, and tools.

Chvor could express its Brain configuration as a similarly composable profile:

```text
Brain Profile
├── Identity
├── Models
├── Memory policy
├── Skills
├── Knowledge
├── Tools
├── Integrations
└── Autonomy policy
```

Profiles could be exported, cloned, compared, or attached to different channels. See [Open WebUI Workspace](https://docs.openwebui.com/features/workspace/).

## 10. Temporal: adopt durable execution semantics

Chvor may not need Temporal itself, especially while remaining local-first. Its scheduled tasks, approval waits, OAuth handoffs, browser jobs, and long-running research should nevertheless adopt Temporal-like invariants:

- Every side effect has an idempotency key.
- Every wait is persisted.
- Every retry policy is explicit.
- Restarting the server cannot lose an active task.
- A user response is a durable signal.
- Execution history is append-only and replayable.

See the [Temporal documentation](https://docs.temporal.io/).

## Recommended sequence

### Phase 1: Make behavior measurable

Borrow from Langfuse and n8n:

- Define a unified trajectory format.
- Add full per-step inspection.
- Add **Save as evaluation**.
- Create regression datasets.
- Compare prompts, models, engines, and memory policies.

### Phase 2: Make memory understandable

Borrow from Letta:

- Add structured memory blocks.
- Establish an explicit context hierarchy.
- Add memory revision history.
- Track confidence and provenance.
- Let users inspect and correct beliefs.

### Phase 3: Make integrations trustworthy

Borrow from Home Assistant and Goose:

- Define integration manifests.
- Standardize setup and reauthentication.
- Introduce quality tiers.
- Declare capabilities and security requirements.
- Package workflows as recipes.

### Phase 4: Make execution durable

Borrow from LangGraph, OpenHands, and Temporal:

- Persist checkpoints.
- Support retry, fork, and replay.
- Make approvals crash-safe.
- Introduce replaceable execution runtimes.
- Make background work recoverable.

### Phase 5: Standardize interactive output

Adopt MCP Apps:

- Render tool-provided interfaces safely.
- Define a unified action protocol.
- Associate interactions with execution history.
- Keep A2UI through a compatibility layer where useful.

## Projects not to use as Chvor's architectural center

### Dify

Dify is useful for low-code workflow and knowledge UX, but its core mental model would pull Chvor toward being a generic AI application builder.

### Mastra

[Mastra](https://mastra.ai/) is a strong TypeScript framework with workflows, human-in-the-loop support, evaluations, schedules, and observability. It overlaps heavily with both Pi and Chvor's control plane and should be studied rather than embedded alongside another engine.

### Open WebUI

Open WebUI provides strong configuration UX but is too chat- and model-centric to define Chvor's product.

### LangGraph

LangGraph has excellent durability concepts, but it would be unnecessary as a second agent engine if Chvor adopts Pi.

### n8n

n8n has excellent execution UX, but Chvor should not require users to manually draw deterministic workflows.

## Target architecture

```text
Channels / UI / Schedules
           │
           ▼
    Chvor control plane
 identity · memory · policy
 credentials · integrations
 durable execution · evals
           │
           ▼
      Pi agent engine
 model stream · tool loop
 retry · compaction · events
           │
           ▼
   Chvor tool/runtime adapters
           │
           ▼
 Canvas history / persistence
```

The target is not merely an agent with an attractive visualizer. It is an agent operating system where users can:

- See what the agent believes
- Understand why it acted
- Inspect every side effect
- Replay or correct decisions
- Trust installed capabilities
- Measure whether changes actually improve behavior
