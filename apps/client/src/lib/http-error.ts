export interface RevisionConflictMetadata {
  expectedRevision: number;
  actualRevision: number;
}

export class HttpError extends Error {
  readonly status: number;
  declare readonly expectedRevision?: number;
  declare readonly actualRevision?: number;

  constructor(status: number, message: string, conflict?: RevisionConflictMetadata) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    if (conflict) {
      this.expectedRevision = conflict.expectedRevision;
      this.actualRevision = conflict.actualRevision;
    }
  }
}

export { HttpError as ApiHttpError };

export function responseErrorMessage(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;

  const { error, detail } = body as { error?: unknown; detail?: unknown };
  const headline = typeof error === "string" && error.length > 0 ? error : fallback;

  return typeof detail === "string" && detail.length > 0 ? `${headline}: ${detail}` : headline;
}

function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 2_147_483_647;
}

export function responseRevisionConflict(
  status: number,
  body: unknown
): RevisionConflictMetadata | undefined {
  if (status !== 409 || typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }

  const expected = Object.getOwnPropertyDescriptor(body, "expectedRevision")?.value;
  const actual = Object.getOwnPropertyDescriptor(body, "actualRevision")?.value;
  return revision(expected) && revision(actual)
    ? { expectedRevision: expected, actualRevision: actual }
    : undefined;
}

export function responseHttpError(status: number, body: unknown, fallback: string): HttpError {
  return new HttpError(
    status,
    responseErrorMessage(body, fallback),
    responseRevisionConflict(status, body)
  );
}
