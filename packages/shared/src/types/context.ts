import { z } from "zod";

/** Current interchange version of the shared context-assembly contract. */
export const CONTEXT_SCHEMA_VERSION = 1 as const;

/** The complete context hierarchy, in deterministic precedence order. */
export const CONTEXT_LAYER_ORDER = [
  "identity",
  "human",
  "working",
  "procedural",
  "episodic",
  "knowledge",
] as const;

export type ContextLayer = (typeof CONTEXT_LAYER_ORDER)[number];

/** Defensive boundary limits. They do not prescribe a model's context window. */
export const CONTEXT_PAYLOAD_LIMITS = {
  maxDepth: 32,
  maxNodesPerContent: 10_000,
  // B11 accepts a 1,000,000-code-point block inside a document bounded to
  // 4 MiB. JSON escaping can expand that content, so the runtime boundary must
  // accept every already-valid persisted block before budgeting it.
  maxContentCharacters: 8_000_000,
  maxAssemblyCharacters: 4_000_000,
  // The server source caps are 1,000 stable blocks, 500 working items, and 30
  // graph rows. Keep the aggregate boundary above that combined maximum.
  maxItems: 2_000,
  maxReasonsPerItem: 16,
  maxStringLength: 4_096,
  maxTokens: 10_000_000,
} as const;

export const CONTEXT_COMPATIBILITY = {
  exactLayerSetAndOrder: true,
  additiveFields: "reject",
  unknownEnumValues: "reject",
  unsupportedSchemaVersions: "reject",
} as const;

export const contextOwnerSchema = z.enum(["system", "user", "agent", "runtime", "workspace"]);
export const contextMutabilitySchema = z.enum([
  "immutable",
  "user-editable",
  "agent-editable",
  "runtime-only",
]);
export const contextModelVisibilitySchema = z.enum(["always", "conditional", "retrieval-only"]);
export const contextAuthoritySchema = z.enum(["system", "user", "untrusted-data"]);
export const contextBudgetAllocationSchema = z.enum(["reserved", "elastic"]);
export const contextBudgetOverflowSchema = z.enum(["reject", "truncate"]);

export type ContextOwner = z.infer<typeof contextOwnerSchema>;
export type ContextMutability = z.infer<typeof contextMutabilitySchema>;
export type ContextModelVisibility = z.infer<typeof contextModelVisibilitySchema>;
export type ContextAuthority = z.infer<typeof contextAuthoritySchema>;

interface ContextLayerPolicyDefinition {
  layer: ContextLayer;
  allowedOwners: readonly ContextOwner[];
  allowedMutability: readonly ContextMutability[];
  modelVisibility: ContextModelVisibility;
  budgetPolicy: {
    allocation: z.infer<typeof contextBudgetAllocationSchema>;
    overflow: z.infer<typeof contextBudgetOverflowSchema>;
  };
  allowedAuthority: readonly ContextAuthority[];
  precedence: number;
}

/**
 * Canonical v1 policy table. Policy data is repeated in assemblies so traces
 * remain self-describing, then checked byte-for-byte against these definitions.
 */
export const CONTEXT_LAYER_POLICIES = [
  {
    layer: "identity",
    allowedOwners: ["system", "user"],
    allowedMutability: ["immutable", "user-editable"],
    modelVisibility: "always",
    budgetPolicy: { allocation: "reserved", overflow: "reject" },
    allowedAuthority: ["system", "user"],
    precedence: 1,
  },
  {
    layer: "human",
    allowedOwners: ["user", "system"],
    allowedMutability: ["user-editable", "immutable"],
    modelVisibility: "always",
    budgetPolicy: { allocation: "reserved", overflow: "truncate" },
    allowedAuthority: ["user", "system"],
    precedence: 2,
  },
  {
    layer: "working",
    allowedOwners: ["runtime", "user", "agent"],
    allowedMutability: ["runtime-only", "user-editable", "agent-editable"],
    modelVisibility: "conditional",
    budgetPolicy: { allocation: "elastic", overflow: "truncate" },
    allowedAuthority: ["system", "user", "untrusted-data"],
    precedence: 3,
  },
  {
    layer: "procedural",
    allowedOwners: ["system", "workspace", "user", "agent"],
    allowedMutability: ["immutable", "user-editable", "agent-editable"],
    modelVisibility: "conditional",
    budgetPolicy: { allocation: "reserved", overflow: "truncate" },
    allowedAuthority: ["system", "user", "untrusted-data"],
    precedence: 4,
  },
  {
    layer: "episodic",
    allowedOwners: ["user", "agent", "runtime"],
    allowedMutability: ["user-editable", "agent-editable", "runtime-only"],
    modelVisibility: "retrieval-only",
    budgetPolicy: { allocation: "elastic", overflow: "truncate" },
    allowedAuthority: ["untrusted-data"],
    precedence: 5,
  },
  {
    layer: "knowledge",
    allowedOwners: ["workspace", "user", "agent"],
    allowedMutability: ["immutable", "user-editable", "agent-editable"],
    modelVisibility: "retrieval-only",
    budgetPolicy: { allocation: "elastic", overflow: "truncate" },
    allowedAuthority: ["untrusted-data"],
    precedence: 6,
  },
] as const satisfies readonly ContextLayerPolicyDefinition[];

const policyByLayer = Object.fromEntries(
  CONTEXT_LAYER_POLICIES.map((policy) => [policy.layer, policy])
) as Record<ContextLayer, (typeof CONTEXT_LAYER_POLICIES)[number]>;

export const contextLayerSchema = z.enum(CONTEXT_LAYER_ORDER);

export const contextLayerPolicySchema = z
  .object({
    layer: contextLayerSchema,
    allowedOwners: z.array(contextOwnerSchema).nonempty(),
    allowedMutability: z.array(contextMutabilitySchema).nonempty(),
    modelVisibility: contextModelVisibilitySchema,
    budgetPolicy: z
      .object({
        allocation: contextBudgetAllocationSchema,
        overflow: contextBudgetOverflowSchema,
      })
      .strict(),
    allowedAuthority: z.array(contextAuthoritySchema).nonempty(),
    precedence: z.number().int().min(1).max(CONTEXT_LAYER_ORDER.length),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (JSON.stringify(policy) !== JSON.stringify(policyByLayer[policy.layer])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `policy must exactly match the fixed ${policy.layer} policy`,
      });
    }
  });

export type ContextLayerPolicy = z.infer<typeof contextLayerPolicySchema>;

export type ContextJsonValue =
  | null
  | boolean
  | number
  | string
  | ContextJsonValue[]
  | { [key: string]: ContextJsonValue };

interface JsonState {
  seen: Set<unknown>;
  nodes: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isContextJsonValue(
  value: unknown,
  state: JsonState = { seen: new Set(), nodes: 0 },
  depth = 0
): value is ContextJsonValue {
  state.nodes += 1;
  if (depth > CONTEXT_PAYLOAD_LIMITS.maxDepth) return false;
  if (state.nodes > CONTEXT_PAYLOAD_LIMITS.maxNodesPerContent) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= CONTEXT_PAYLOAD_LIMITS.maxContentCharacters;
  if (typeof value !== "object" || state.seen.has(value)) return false;
  state.seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    const propertyNames = Object.getOwnPropertyNames(value);
    if (propertyNames.length !== value.length + 1 || !propertyNames.includes("length"))
      return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return false;
      if (!isContextJsonValue(descriptor.value, state, depth + 1)) return false;
    }
    return true;
  }
  if (!isPlainObject(value)) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.entries(Object.getOwnPropertyDescriptors(value)).every(([key, descriptor]) => {
    if (key === "__proto__" || key === "prototype" || key === "constructor") return false;
    if (!("value" in descriptor) || !descriptor.enumerable) return false;
    return isContextJsonValue(descriptor.value, state, depth + 1);
  });
}

function hasBoundedSerialization(value: unknown, limit: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && serialized.length <= limit;
  } catch {
    return false;
  }
}

/** Runtime content is finite, acyclic, bounded JSON. It is never put in a trace. */
export const contextRuntimeContentSchema = z
  .unknown()
  .refine(
    (value): value is ContextJsonValue =>
      isContextJsonValue(value) &&
      hasBoundedSerialization(value, CONTEXT_PAYLOAD_LIMITS.maxContentCharacters),
    {
      message: "runtime content must be finite, acyclic, bounded JSON data",
    }
  );

const boundedStringSchema = z.string().min(1).max(CONTEXT_PAYLOAD_LIMITS.maxStringLength);
const idSchema = z.string().min(1).max(256);
const tokenSchema = z.number().int().nonnegative().max(CONTEXT_PAYLOAD_LIMITS.maxTokens);
const timestampSchema = z
  .string()
  .datetime({ offset: true, precision: 3 })
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: "timestamp must identify a valid millisecond-precision instant",
  });

export const contextAssemblyConfigurationSchema = z
  .object({
    tokenizer: z.object({ id: boundedStringSchema, version: boundedStringSchema }).strict(),
    retrievalScoring: z.object({ id: boundedStringSchema, version: boundedStringSchema }).strict(),
    contextWindowTokens: tokenSchema,
    systemInstructionTokens: tokenSchema,
    developerInstructionTokens: tokenSchema,
    currentRequestTokens: tokenSchema,
    otherPromptTokens: tokenSchema,
    responseReserveTokens: tokenSchema,
    toolDefinitionTokens: tokenSchema,
    hierarchyBudgetTokens: tokenSchema,
  })
  .strict()
  .superRefine((configuration, ctx) => {
    const reserved =
      configuration.systemInstructionTokens +
      configuration.developerInstructionTokens +
      configuration.currentRequestTokens +
      configuration.otherPromptTokens +
      configuration.responseReserveTokens +
      configuration.toolDefinitionTokens;
    if (reserved > configuration.contextWindowTokens) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "outside-hierarchy inputs and reservations exceed the context window",
      });
      return;
    }
    if (configuration.hierarchyBudgetTokens !== configuration.contextWindowTokens - reserved) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "hierarchy budget must equal the unreserved context window",
      });
    }
  });

export const contextReferenceSchema = z
  .object({
    namespace: boundedStringSchema,
    id: idSchema,
    revision: boundedStringSchema,
  })
  .strict()
  .superRefine((reference, ctx) => {
    for (const field of ["namespace", "id", "revision"] as const) {
      if (reference[field] !== reference[field].normalize("NFC")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: "context references must be NFC-normalized",
        });
      }
    }
  });

export const contextSourceSchema = z
  .object({
    kind: z.enum(["block", "message", "memory", "procedure", "document", "runtime", "external"]),
    id: idSchema,
    revision: boundedStringSchema,
  })
  .strict();

export const contextInclusionReasonSchema = z
  .object({
    kind: z.enum(["required", "explicit", "active", "recent", "retrieved", "dependency"]),
    code: z.enum([
      "contract-required",
      "configured-profile",
      "active-session",
      "recent-message",
      "rolling-summary",
      "capability-enabled",
      "workflow-query-match",
      "semantic-match",
      "category-match",
      "graph-association",
      "topic-prediction",
      "recency-fallback",
      "resource-match",
      "runtime-state",
    ]),
    score: z.number().finite().optional(),
    rank: z.number().finite().int().nonnegative().optional(),
    relation: z
      .enum([
        "temporal",
        "causal",
        "semantic",
        "entity",
        "contradiction",
        "supersedes",
        "narrative",
      ])
      .optional(),
  })
  .strict();

export const contextRepresentationSchema = z
  .object({
    kind: z.enum(["full", "compact"]),
    id: boundedStringSchema,
    version: boundedStringSchema,
  })
  .strict();

export const contextOrderingSchema = z
  .object({
    canonicalRank: z.number().int().positive().max(CONTEXT_PAYLOAD_LIMITS.maxItems),
    declaredOrder: z.number().finite().optional(),
    turnIndex: z.number().int().nonnegative().optional(),
    completionState: z.enum(["unresolved", "completed"]).optional(),
    eventTime: timestampSchema.nullable().optional(),
    procedurePriority: z.enum(["required", "optional"]).optional(),
    scopeSpecificity: z.number().int().nonnegative().optional(),
    retrievalScore: z.number().finite().nullable().optional(),
  })
  .strict();

const tokenAccountingShape = {
  sourceTokens: tokenSchema,
  includedTokens: tokenSchema,
  truncatedTokens: tokenSchema,
};

function validateTokenIdentity(
  accounting: { sourceTokens: number; includedTokens: number; truncatedTokens: number },
  ctx: z.RefinementCtx
): void {
  if (accounting.sourceTokens !== accounting.includedTokens + accounting.truncatedTokens) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "sourceTokens must equal includedTokens plus truncatedTokens",
    });
  }
}

export const contextTokenAccountingSchema = z
  .object(tokenAccountingShape)
  .strict()
  .superRefine(validateTokenIdentity);

export const contextLayerTokenAccountingSchema = z
  .object({
    ...tokenAccountingShape,
    overflowTokens: tokenSchema,
  })
  .strict()
  .superRefine(validateTokenIdentity);

const contextAssemblyItemShape = {
  id: idSchema,
  owner: contextOwnerSchema,
  mutability: contextMutabilitySchema,
  modelVisibility: contextModelVisibilitySchema,
  authority: contextAuthoritySchema,
  reference: contextReferenceSchema,
  source: contextSourceSchema,
  representation: contextRepresentationSchema,
  ordering: contextOrderingSchema,
  inclusionReasons: z
    .array(contextInclusionReasonSchema)
    .min(1)
    .max(CONTEXT_PAYLOAD_LIMITS.maxReasonsPerItem),
  accounting: contextTokenAccountingSchema,
};

export const contextAssemblyItemSchema = z
  .object({
    ...contextAssemblyItemShape,
    content: contextRuntimeContentSchema,
  })
  .strict();

export const contextTraceItemSchema = z.object(contextAssemblyItemShape).strict();

type AssemblyItem = z.infer<typeof contextAssemblyItemSchema>;
type TraceItem = z.infer<typeof contextTraceItemSchema>;
type LayerAccounting = z.infer<typeof contextLayerTokenAccountingSchema>;

interface LayerLike<TItem extends AssemblyItem | TraceItem> {
  layer: ContextLayer;
  policy: ContextLayerPolicy;
  tokenBudget: number;
  items: TItem[];
  accounting: LayerAccounting;
}

function addIssue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}

function compareReferences(
  left: AssemblyItem | TraceItem,
  right: AssemblyItem | TraceItem
): number {
  for (const field of ["namespace", "id", "revision"] as const) {
    const comparison = compareUtf8(left.reference[field], right.reference[field]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function compareDescending(left: number, right: number): number {
  return right - left;
}

function compareEventTimesDescending(left: string | null, right: string | null): number {
  if (left === null && right !== null) return 1;
  if (left !== null && right === null) return -1;
  if (left === null || right === null) return 0;
  return compareDescending(Date.parse(left), Date.parse(right));
}

function compareCanonicalItems(
  layer: ContextLayer,
  left: AssemblyItem | TraceItem,
  right: AssemblyItem | TraceItem
): number {
  const leftOrdering = left.ordering;
  const rightOrdering = right.ordering;
  let comparison = 0;
  switch (layer) {
    case "identity":
    case "human":
      comparison = leftOrdering.declaredOrder! - rightOrdering.declaredOrder!;
      break;
    case "working":
      comparison = compareDescending(leftOrdering.turnIndex!, rightOrdering.turnIndex!);
      if (comparison === 0) {
        comparison =
          (leftOrdering.completionState === "unresolved" ? 0 : 1) -
          (rightOrdering.completionState === "unresolved" ? 0 : 1);
      }
      if (comparison === 0) {
        comparison = compareEventTimesDescending(leftOrdering.eventTime!, rightOrdering.eventTime!);
      }
      break;
    case "procedural":
      comparison =
        (leftOrdering.procedurePriority === "required" ? 0 : 1) -
        (rightOrdering.procedurePriority === "required" ? 0 : 1);
      if (comparison === 0) {
        comparison = compareDescending(
          leftOrdering.scopeSpecificity!,
          rightOrdering.scopeSpecificity!
        );
      }
      if (comparison === 0) {
        comparison = leftOrdering.declaredOrder! - rightOrdering.declaredOrder!;
      }
      break;
    case "episodic":
    case "knowledge": {
      const leftScore = leftOrdering.retrievalScore;
      const rightScore = rightOrdering.retrievalScore;
      if (leftScore === null && rightScore !== null) comparison = 1;
      else if (leftScore !== null && rightScore === null) comparison = -1;
      else if (leftScore !== null && rightScore !== null) {
        comparison = compareDescending(leftScore!, rightScore!);
      }
      if (comparison === 0) {
        comparison = compareEventTimesDescending(leftOrdering.eventTime!, rightOrdering.eventTime!);
      }
      break;
    }
  }
  return comparison === 0 ? compareReferences(left, right) : comparison;
}

function validateLayer<TItem extends AssemblyItem | TraceItem>(
  value: LayerLike<TItem>,
  ctx: z.RefinementCtx
): void {
  if (value.policy.layer !== value.layer) {
    addIssue(ctx, ["policy", "layer"], "layer policy must match its containing layer");
  }

  for (const [index, item] of value.items.entries()) {
    if (item.ordering.canonicalRank !== index + 1) {
      addIssue(
        ctx,
        ["items", index, "ordering", "canonicalRank"],
        "canonical rank must be contiguous and match item order"
      );
    }
    const requiredOrderingFields: Record<ContextLayer, readonly (keyof typeof item.ordering)[]> = {
      identity: ["declaredOrder"],
      human: ["declaredOrder"],
      working: ["turnIndex", "completionState", "eventTime"],
      procedural: ["procedurePriority", "scopeSpecificity", "declaredOrder"],
      episodic: ["retrievalScore", "eventTime"],
      knowledge: ["retrievalScore", "eventTime"],
    };
    for (const field of requiredOrderingFields[value.layer]) {
      if (item.ordering[field] === undefined) {
        addIssue(
          ctx,
          ["items", index, "ordering", field],
          `${field} is required for ${value.layer} ordering`
        );
      }
    }
    if (index > 0 && compareCanonicalItems(value.layer, value.items[index - 1], item) > 0) {
      addIssue(
        ctx,
        ["items", index, "ordering"],
        `items are not in canonical ${value.layer} order`
      );
    }
    if (!value.policy.allowedOwners.includes(item.owner)) {
      addIssue(ctx, ["items", index, "owner"], "item owner is not allowed by layer policy");
    }
    if (!value.policy.allowedMutability.includes(item.mutability)) {
      addIssue(
        ctx,
        ["items", index, "mutability"],
        "item mutability is not allowed by layer policy"
      );
    }
    if (item.modelVisibility !== value.policy.modelVisibility) {
      addIssue(ctx, ["items", index, "modelVisibility"], "item visibility must match layer policy");
    }
    if (!value.policy.allowedAuthority.includes(item.authority)) {
      addIssue(ctx, ["items", index, "authority"], "item authority is not allowed by layer policy");
    }
    if (item.representation.kind === "full" && item.accounting.truncatedTokens > 0) {
      addIssue(
        ctx,
        ["items", index, "representation", "kind"],
        "a truncated item must use an approved compact representation"
      );
    }
  }

  const sums = value.items.reduce(
    (total, item) => ({
      sourceTokens: total.sourceTokens + item.accounting.sourceTokens,
      includedTokens: total.includedTokens + item.accounting.includedTokens,
      truncatedTokens: total.truncatedTokens + item.accounting.truncatedTokens,
    }),
    { sourceTokens: 0, includedTokens: 0, truncatedTokens: 0 }
  );
  for (const key of ["sourceTokens", "includedTokens", "truncatedTokens"] as const) {
    if (value.accounting[key] !== sums[key]) {
      addIssue(ctx, ["accounting", key], `${key} must equal the sum of item accounting`);
    }
  }

  const expectedOverflow = Math.max(0, sums.sourceTokens - value.tokenBudget);
  if (value.accounting.overflowTokens !== expectedOverflow) {
    addIssue(
      ctx,
      ["accounting", "overflowTokens"],
      "overflowTokens must equal source tokens above the layer budget"
    );
  }
  if (sums.includedTokens > value.tokenBudget) {
    addIssue(ctx, ["accounting", "includedTokens"], "included tokens exceed the layer budget");
  }
  const compactedTokens = value.items.reduce(
    (total, item) =>
      total + (item.representation.kind === "compact" ? item.accounting.truncatedTokens : 0),
    0
  );
  if (
    value.policy.budgetPolicy.overflow === "reject" &&
    value.accounting.overflowTokens > compactedTokens
  ) {
    addIssue(
      ctx,
      ["accounting", "overflowTokens"],
      "reject-overflow layers require an approved compact form to handle overflow"
    );
  }
}

const layerBaseShape = {
  policy: contextLayerPolicySchema,
  tokenBudget: tokenSchema,
  items: z.array(contextAssemblyItemSchema).max(CONTEXT_PAYLOAD_LIMITS.maxItems),
  accounting: contextLayerTokenAccountingSchema,
};

const traceLayerBaseShape = {
  policy: contextLayerPolicySchema,
  tokenBudget: tokenSchema,
  items: z.array(contextTraceItemSchema).max(CONTEXT_PAYLOAD_LIMITS.maxItems),
  accounting: contextLayerTokenAccountingSchema,
};

function assemblyLayerSchema(layer: ContextLayer) {
  return z
    .object({ layer: z.literal(layer), ...layerBaseShape })
    .strict()
    .superRefine(validateLayer);
}

function traceLayerSchema(layer: ContextLayer) {
  return z
    .object({ layer: z.literal(layer), ...traceLayerBaseShape })
    .strict()
    .superRefine(validateLayer);
}

export const contextAssemblyLayersSchema = z.tuple([
  assemblyLayerSchema("identity"),
  assemblyLayerSchema("human"),
  assemblyLayerSchema("working"),
  assemblyLayerSchema("procedural"),
  assemblyLayerSchema("episodic"),
  assemblyLayerSchema("knowledge"),
]);

export const contextTraceLayersSchema = z.tuple([
  traceLayerSchema("identity"),
  traceLayerSchema("human"),
  traceLayerSchema("working"),
  traceLayerSchema("procedural"),
  traceLayerSchema("episodic"),
  traceLayerSchema("knowledge"),
]);

function validateAssemblyTotals(
  value: {
    configuration: z.infer<typeof contextAssemblyConfigurationSchema>;
    layers: readonly LayerLike<AssemblyItem | TraceItem>[];
    accounting: LayerAccounting;
  },
  ctx: z.RefinementCtx
): void {
  const ids = new Set<string>();
  const references = new Set<string>();
  let totalItems = 0;
  for (const [layerIndex, layer] of value.layers.entries()) {
    totalItems += layer.items.length;
    for (const [itemIndex, item] of layer.items.entries()) {
      if (ids.has(item.id)) {
        addIssue(
          ctx,
          ["layers", layerIndex, "items", itemIndex, "id"],
          "duplicate context item id"
        );
      }
      ids.add(item.id);
      const referenceKey = JSON.stringify([
        item.reference.namespace,
        item.reference.id,
        item.reference.revision,
      ]);
      if (references.has(referenceKey)) {
        addIssue(
          ctx,
          ["layers", layerIndex, "items", itemIndex, "reference"],
          "duplicate canonical context reference"
        );
      }
      references.add(referenceKey);
    }
  }
  if (totalItems > CONTEXT_PAYLOAD_LIMITS.maxItems) {
    addIssue(ctx, ["layers"], "context assembly exceeds the global item limit");
  }

  const totals = value.layers.reduce(
    (total, layer) => ({
      tokenBudget: total.tokenBudget + layer.tokenBudget,
      sourceTokens: total.sourceTokens + layer.accounting.sourceTokens,
      includedTokens: total.includedTokens + layer.accounting.includedTokens,
      truncatedTokens: total.truncatedTokens + layer.accounting.truncatedTokens,
      overflowTokens: total.overflowTokens + layer.accounting.overflowTokens,
    }),
    { tokenBudget: 0, sourceTokens: 0, includedTokens: 0, truncatedTokens: 0, overflowTokens: 0 }
  );
  if (value.configuration.hierarchyBudgetTokens !== totals.tokenBudget) {
    addIssue(
      ctx,
      ["configuration", "hierarchyBudgetTokens"],
      "hierarchy budget must equal the sum of layer budgets"
    );
  }
  for (const key of [
    "sourceTokens",
    "includedTokens",
    "truncatedTokens",
    "overflowTokens",
  ] as const) {
    if (value.accounting[key] !== totals[key]) {
      addIssue(ctx, ["accounting", key], `${key} must equal the sum of layer accounting`);
    }
  }
}

function hasBoundedItemSerialization(
  layers: readonly LayerLike<AssemblyItem | TraceItem>[],
  limit: number
): boolean {
  let serializedCharacters = 0;
  try {
    for (const layer of layers) {
      for (const item of layer.items) {
        if ("content" in item && !isContextJsonValue(item.content)) return false;
        serializedCharacters += JSON.stringify(item).length;
        if (serializedCharacters > limit) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

const assemblyEnvelopeShape = {
  schemaVersion: z.literal(CONTEXT_SCHEMA_VERSION),
  id: idSchema,
  createdAt: timestampSchema,
  configuration: contextAssemblyConfigurationSchema,
  accounting: contextLayerTokenAccountingSchema,
};

export const contextAssemblySchema = z
  .object({
    ...assemblyEnvelopeShape,
    layers: contextAssemblyLayersSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    validateAssemblyTotals(value, ctx);
    if (
      !hasBoundedItemSerialization(value.layers, CONTEXT_PAYLOAD_LIMITS.maxAssemblyCharacters) ||
      !hasBoundedSerialization(value, CONTEXT_PAYLOAD_LIMITS.maxAssemblyCharacters)
    ) {
      addIssue(ctx, [], "context assembly exceeds the serialized character limit");
    }
  });

export const contextAssemblyTraceSchema = z
  .object({
    ...assemblyEnvelopeShape,
    layers: contextTraceLayersSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    validateAssemblyTotals(value, ctx);
    if (
      !hasBoundedItemSerialization(value.layers, CONTEXT_PAYLOAD_LIMITS.maxAssemblyCharacters) ||
      !hasBoundedSerialization(value, CONTEXT_PAYLOAD_LIMITS.maxAssemblyCharacters)
    ) {
      addIssue(ctx, [], "context trace exceeds the serialized character limit");
    }
  });

export type ContextAssemblyItem = z.infer<typeof contextAssemblyItemSchema>;
export type ContextTraceItem = z.infer<typeof contextTraceItemSchema>;
export type ContextAssemblyV1 = z.infer<typeof contextAssemblySchema>;
export type ContextAssemblyTraceV1 = z.infer<typeof contextAssemblyTraceSchema>;

export function parseContextAssembly(value: unknown): ContextAssemblyV1 {
  return contextAssemblySchema.parse(value);
}

export function safeParseContextAssembly(value: unknown) {
  return contextAssemblySchema.safeParse(value);
}

export function serializeContextAssembly(value: unknown): string {
  return JSON.stringify(parseContextAssembly(value));
}

export function parseContextAssemblyTrace(value: unknown): ContextAssemblyTraceV1 {
  return contextAssemblyTraceSchema.parse(value);
}

export function safeParseContextAssemblyTrace(value: unknown) {
  return contextAssemblyTraceSchema.safeParse(value);
}

/** Parse a runtime assembly and return the validated, content-free trace view. */
export function projectContextAssemblyTrace(value: unknown): ContextAssemblyTraceV1 {
  const assembly = parseContextAssembly(value);
  return parseContextAssemblyTrace({
    schemaVersion: assembly.schemaVersion,
    id: assembly.id,
    createdAt: assembly.createdAt,
    configuration: assembly.configuration,
    layers: assembly.layers.map((layer) => ({
      layer: layer.layer,
      policy: layer.policy,
      tokenBudget: layer.tokenBudget,
      items: layer.items.map((item) => ({
        id: item.id,
        owner: item.owner,
        mutability: item.mutability,
        modelVisibility: item.modelVisibility,
        authority: item.authority,
        reference: item.reference,
        source: item.source,
        representation: item.representation,
        ordering: item.ordering,
        inclusionReasons: item.inclusionReasons,
        accounting: item.accounting,
      })),
      accounting: layer.accounting,
    })),
    accounting: assembly.accounting,
  });
}

export function serializeContextAssemblyTrace(value: unknown): string {
  return JSON.stringify(projectContextAssemblyTrace(value));
}
