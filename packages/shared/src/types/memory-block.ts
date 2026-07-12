import { z } from "zod";

export const MEMORY_BLOCK_SCHEMA_VERSION = 1 as const;

export const MEMORY_BLOCK_LIMITS = {
  labelCodePoints: 256,
  descriptionCodePoints: 4_096,
  contentCodePoints: 1_000_000,
  provenanceBytes: 65_536,
  documentBytes: 4 * 1024 * 1024,
  actorIdCodePoints: 256,
  maxJsonDepth: 32,
  maxJsonNodes: 10_000,
} as const;

export const memoryBlockLayerSchema = z.enum(["identity", "human", "procedural"]);
export const memoryBlockManagerSchema = z.enum(["user", "agent"]);
export const memoryBlockOperationSchema = z.enum(["create", "update", "restore"]);
export const memoryBlockActorTypeSchema = z.enum([
  "user",
  "session",
  "apikey",
  "agent",
  "channel",
  "schedule",
  "daemon",
  "webhook",
  "system",
  "test",
]);

export type MemoryBlockJsonValue =
  | null
  | boolean
  | number
  | string
  | MemoryBlockJsonValue[]
  | { [key: string]: MemoryBlockJsonValue };

interface JsonState {
  seen: Set<unknown>;
  nodes: number;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validJson(
  value: unknown,
  state: JsonState = { seen: new Set(), nodes: 0 },
  depth = 0
): value is MemoryBlockJsonValue {
  state.nodes += 1;
  if (depth > MEMORY_BLOCK_LIMITS.maxJsonDepth || state.nodes > MEMORY_BLOCK_LIMITS.maxJsonNodes) {
    return false;
  }
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return !value.includes("\0");
  if (typeof value !== "object" || state.seen.has(value)) return false;
  state.seen.add(value);
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== value.length + 1 || !names.includes("length")) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return false;
      if (!validJson(descriptor.value, state, depth + 1)) return false;
    }
    return true;
  }
  if (!plainObject(value)) return false;
  return Object.entries(Object.getOwnPropertyDescriptors(value)).every(([key, descriptor]) => {
    if (key === "__proto__" || key === "prototype" || key === "constructor") return false;
    return (
      "value" in descriptor &&
      descriptor.enumerable &&
      validJson(descriptor.value, state, depth + 1)
    );
  });
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

function boundedText(max: number) {
  return z
    .string()
    .refine((value) => !value.includes("\0"), "text must not contain NUL")
    .refine((value) => codePoints(value) <= max, `text exceeds ${max} Unicode code points`);
}

const MEMORY_BLOCK_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/;
const memoryBlockTimestampSyntaxSchema = z.string().datetime({ offset: true, precision: 3 });

export function isMemoryBlockTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    MEMORY_BLOCK_TIMESTAMP_PATTERN.test(value) &&
    memoryBlockTimestampSyntaxSchema.safeParse(value).success &&
    Number.isFinite(Date.parse(value))
  );
}

const timestampSchema = memoryBlockTimestampSyntaxSchema.refine(
  isMemoryBlockTimestamp,
  "timestamp must identify a valid millisecond-precision instant"
);

export const memoryBlockProvenanceSchema = z
  .unknown()
  .refine(
    (value): value is Record<string, MemoryBlockJsonValue> =>
      plainObject(value) &&
      validJson(value) &&
      utf8Bytes(value) >= 2 &&
      utf8Bytes(value) <= MEMORY_BLOCK_LIMITS.provenanceBytes,
    "provenance must be a bounded structured JSON object"
  )
  .transform((value) => JSON.parse(JSON.stringify(value)) as Record<string, MemoryBlockJsonValue>);

const documentBase = {
  schemaVersion: z.literal(MEMORY_BLOCK_SCHEMA_VERSION),
  label: boundedText(MEMORY_BLOCK_LIMITS.labelCodePoints).refine(
    (value) => value.trim().length > 0,
    "label must not be empty"
  ),
  description: boundedText(MEMORY_BLOCK_LIMITS.descriptionCodePoints).nullable(),
  content: boundedText(MEMORY_BLOCK_LIMITS.contentCodePoints),
  characterBudget: z
    .object({
      unit: z.literal("characters"),
      limit: z.number().int().min(1).max(MEMORY_BLOCK_LIMITS.contentCodePoints),
    })
    .strict(),
  declaredOrder: z.number().int().min(0).max(2_147_483_647),
  readOnly: z.boolean(),
  confidence: z.number().finite().min(0).max(1),
  provenance: memoryBlockProvenanceSchema,
  verifiedAt: timestampSchema.nullable(),
};

const identityDocumentSchema = z
  .object({
    ...documentBase,
    layer: z.literal("identity"),
    managedBy: z.literal("user"),
  })
  .strict();

const humanDocumentSchema = z
  .object({
    ...documentBase,
    layer: z.literal("human"),
    managedBy: z.literal("user"),
  })
  .strict();

const proceduralDocumentSchema = z
  .object({
    ...documentBase,
    layer: z.literal("procedural"),
    managedBy: memoryBlockManagerSchema,
    proceduralPriority: z.enum(["required", "optional"]),
  })
  .strict();

export const memoryBlockDocumentV1Schema = z
  .discriminatedUnion("layer", [
    identityDocumentSchema,
    humanDocumentSchema,
    proceduralDocumentSchema,
  ])
  .superRefine((document, ctx) => {
    if (codePoints(document.content) > document.characterBudget.limit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content"],
        message: "content exceeds its character budget",
      });
    }
    if (utf8Bytes(document) > MEMORY_BLOCK_LIMITS.documentBytes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "memory block document is too large" });
    }
  });

export const memoryBlockActorSchema = z
  .object({
    actorType: memoryBlockActorTypeSchema,
    actorId: boundedText(MEMORY_BLOCK_LIMITS.actorIdCodePoints)
      .refine((value) => codePoints(value) > 0, "actor ID must not be empty")
      .nullable(),
  })
  .strict();

export const memoryBlockCreateSchema = z.object({ document: memoryBlockDocumentV1Schema }).strict();

export const memoryBlockUpdateSchema = z
  .object({
    expectedRevision: z.number().int().positive().max(2_147_483_647),
    document: memoryBlockDocumentV1Schema,
  })
  .strict();

export const memoryBlockRestoreSchema = z
  .object({
    expectedRevision: z.number().int().positive().max(2_147_483_647),
    restoredFromRevision: z.number().int().positive().max(2_147_483_647),
  })
  .strict();

export const memoryBlockRecordSchema = z
  .object({
    id: z.string().min(1).max(256),
    revision: z.number().int().positive().max(2_147_483_647),
    document: memoryBlockDocumentV1Schema,
    operation: memoryBlockOperationSchema,
    actor: memoryBlockActorSchema,
    restoredFromRevision: z.number().int().positive().max(2_147_483_647).nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((record, ctx) => {
    const validOperationState =
      (record.operation === "create" &&
        record.revision === 1 &&
        record.restoredFromRevision === null) ||
      (record.operation === "update" &&
        record.revision > 1 &&
        record.restoredFromRevision === null) ||
      (record.operation === "restore" &&
        record.revision > 1 &&
        record.restoredFromRevision !== null &&
        record.restoredFromRevision < record.revision - 1);
    if (!validOperationState) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["restoredFromRevision"],
        message: "operation, revision, and restore metadata are inconsistent",
      });
    }
    if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["updatedAt"],
        message: "updatedAt must not precede createdAt",
      });
    }
  });

export type MemoryBlockLayer = z.infer<typeof memoryBlockLayerSchema>;
export type MemoryBlockManager = z.infer<typeof memoryBlockManagerSchema>;
export type MemoryBlockOperation = z.infer<typeof memoryBlockOperationSchema>;
export type MemoryBlockActorType = z.infer<typeof memoryBlockActorTypeSchema>;
export type MemoryBlockProvenance = z.infer<typeof memoryBlockProvenanceSchema>;
export type MemoryBlockDocumentV1 = z.infer<typeof memoryBlockDocumentV1Schema>;
export type MemoryBlockActor = z.infer<typeof memoryBlockActorSchema>;
export type MemoryBlockRecord = z.infer<typeof memoryBlockRecordSchema>;

export function memoryBlockCharacterCount(value: string): number {
  return codePoints(value);
}

export function parseMemoryBlockDocument(value: unknown): MemoryBlockDocumentV1 {
  return memoryBlockDocumentV1Schema.parse(value);
}

export function safeParseMemoryBlockDocument(value: unknown) {
  return memoryBlockDocumentV1Schema.safeParse(value);
}
