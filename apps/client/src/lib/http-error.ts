export interface RevisionConflictMetadata {
  expectedRevision: number;
  actualRevision: number;
}

export class HttpError extends Error {
  readonly status: number;
  declare readonly expectedRevision?: number;
  declare readonly actualRevision?: number;
  declare readonly needsSetup?: boolean;
  declare readonly needsReauthentication?: boolean;
  declare readonly setupCredentialType?: string;
  declare readonly code?: string;
  declare readonly flowId?: string;
  declare readonly credentialId?: string;
  declare readonly oauthCredentialId?: string;
  declare readonly connectionId?: string;
  declare readonly failureCode?: string;
  declare readonly authStatus?: string;
  declare readonly candidateCredentialIds?: string[];

  constructor(
    status: number,
    message: string,
    conflict?: RevisionConflictMetadata,
    metadata?: HttpErrorMetadata
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    if (conflict) {
      this.expectedRevision = conflict.expectedRevision;
      this.actualRevision = conflict.actualRevision;
    }
    if (metadata?.needsSetup !== undefined) this.needsSetup = metadata.needsSetup;
    if (metadata?.needsReauthentication !== undefined) {
      this.needsReauthentication = metadata.needsReauthentication;
    }
    if (metadata?.setupCredentialType) this.setupCredentialType = metadata.setupCredentialType;
    if (metadata?.code) this.code = metadata.code;
    if (metadata?.flowId) this.flowId = metadata.flowId;
    if (metadata?.credentialId) this.credentialId = metadata.credentialId;
    if (metadata?.oauthCredentialId) this.oauthCredentialId = metadata.oauthCredentialId;
    if (metadata?.connectionId) this.connectionId = metadata.connectionId;
    if (metadata?.failureCode) this.failureCode = metadata.failureCode;
    if (metadata?.authStatus) this.authStatus = metadata.authStatus;
    if (metadata?.candidateCredentialIds) {
      this.candidateCredentialIds = metadata.candidateCredentialIds;
    }
  }
}

export { HttpError as ApiHttpError };

export function responseErrorMessage(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;

  const { error, detail } = body as { error?: unknown; detail?: unknown };
  const nestedMessage =
    typeof error === "object" && error !== null && !Array.isArray(error)
      ? Object.getOwnPropertyDescriptor(error, "message")?.value
      : undefined;
  const headline =
    typeof error === "string" && error.length > 0
      ? error
      : typeof nestedMessage === "string" && nestedMessage.length > 0
        ? nestedMessage
        : fallback;

  return typeof detail === "string" && detail.length > 0 ? `${headline}: ${detail}` : headline;
}

function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 2_147_483_647;
}

interface HttpErrorMetadata {
  needsSetup?: boolean;
  needsReauthentication?: boolean;
  setupCredentialType?: string;
  code?: string;
  flowId?: string;
  credentialId?: string;
  oauthCredentialId?: string;
  connectionId?: string;
  failureCode?: string;
  authStatus?: string;
  candidateCredentialIds?: string[];
}

function boundedMetadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}

function responseHttpErrorMetadata(body: unknown): HttpErrorMetadata | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const nestedError = Object.getOwnPropertyDescriptor(body, "error")?.value;
  const descriptor = (key: string) => {
    const topLevel = Object.getOwnPropertyDescriptor(body, key)?.value;
    if (topLevel !== undefined) return topLevel;
    return typeof nestedError === "object" && nestedError !== null && !Array.isArray(nestedError)
      ? Object.getOwnPropertyDescriptor(nestedError, key)?.value
      : undefined;
  };
  const needsSetup = descriptor("needsSetup");
  const needsReauthentication = descriptor("needsReauthentication");
  const stringMetadata = (key: string) => boundedMetadataString(descriptor(key));
  const rawCandidateCredentialIds = descriptor("candidateCredentialIds");
  const candidateCredentialIds = Array.isArray(rawCandidateCredentialIds)
    ? rawCandidateCredentialIds
        .map((value) => boundedMetadataString(value))
        .filter((value): value is string => value !== undefined)
        .slice(0, 256)
    : undefined;
  const metadata: HttpErrorMetadata = {
    ...(typeof needsSetup === "boolean" ? { needsSetup } : {}),
    ...(typeof needsReauthentication === "boolean" ? { needsReauthentication } : {}),
    ...(stringMetadata("setupCredentialType")
      ? { setupCredentialType: stringMetadata("setupCredentialType") }
      : {}),
    ...(stringMetadata("code") ? { code: stringMetadata("code") } : {}),
    ...(stringMetadata("flowId") ? { flowId: stringMetadata("flowId") } : {}),
    ...(stringMetadata("credentialId") ? { credentialId: stringMetadata("credentialId") } : {}),
    ...(stringMetadata("oauthCredentialId")
      ? { oauthCredentialId: stringMetadata("oauthCredentialId") }
      : {}),
    ...(stringMetadata("connectionId") ? { connectionId: stringMetadata("connectionId") } : {}),
    ...(stringMetadata("failureCode") ? { failureCode: stringMetadata("failureCode") } : {}),
    ...(stringMetadata("authStatus") ? { authStatus: stringMetadata("authStatus") } : {}),
    ...(candidateCredentialIds && candidateCredentialIds.length > 0
      ? { candidateCredentialIds }
      : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
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
    responseRevisionConflict(status, body),
    responseHttpErrorMetadata(body)
  );
}
