import { describe, it, expect } from "vitest";
import { isSafeImageSrc } from "./components";

describe("isSafeImageSrc", () => {
  it("allows https URLs", () => {
    expect(isSafeImageSrc("https://example.com/img.png")).toBe(true);
  });

  it("allows http URLs", () => {
    expect(isSafeImageSrc("http://example.com/img.png")).toBe(true);
  });

  it("allows data:image URIs", () => {
    expect(isSafeImageSrc("data:image/png;base64,abc123")).toBe(true);
  });

  // Relative and absolute paths are intentionally blocked — they could hit
  // internal API routes (e.g. /api/admin/...) via credentialed GET requests.
  it("blocks absolute paths (could reach internal API routes)", () => {
    expect(isSafeImageSrc("/images/logo.png")).toBe(false);
    expect(isSafeImageSrc("/api/internal")).toBe(false);
  });

  it("blocks relative paths", () => {
    expect(isSafeImageSrc("./assets/icon.svg")).toBe(false);
  });

  it("blocks javascript: URLs", () => {
    expect(isSafeImageSrc("javascript:alert(1)")).toBe(false);
  });

  it("blocks data:text/html", () => {
    expect(isSafeImageSrc("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("blocks empty string", () => {
    expect(isSafeImageSrc("")).toBe(false);
  });

  it("blocks bare filenames", () => {
    expect(isSafeImageSrc("malicious.exe")).toBe(false);
  });

  it("blocks ftp: scheme", () => {
    expect(isSafeImageSrc("ftp://example.com/file")).toBe(false);
  });

  it("is case-insensitive for http", () => {
    expect(isSafeImageSrc("HTTPS://example.com/img.png")).toBe(true);
  });

  it("is case-insensitive for data:image", () => {
    expect(isSafeImageSrc("DATA:IMAGE/png;base64,abc")).toBe(true);
  });
});
