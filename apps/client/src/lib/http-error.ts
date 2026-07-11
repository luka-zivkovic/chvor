export function responseErrorMessage(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;

  const { error, detail } = body as { error?: unknown; detail?: unknown };
  const headline = typeof error === "string" && error.length > 0 ? error : fallback;

  return typeof detail === "string" && detail.length > 0 ? `${headline}: ${detail}` : headline;
}
