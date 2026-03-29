import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "../crypto.ts";

describe("encrypt / decrypt", () => {
  it("round-trips a simple string", () => {
    const plaintext = "hello world";
    const encrypted = encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it("round-trips an empty string", () => {
    const encrypted = encrypt("");
    expect(decrypt(encrypted)).toBe("");
  });

  it("round-trips unicode content", () => {
    const plaintext = "Zdravo svete! Ovo je test. \u{1F600}";
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it("round-trips a long string", () => {
    const plaintext = "x".repeat(10_000);
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it("round-trips special characters (API keys, JSON)", () => {
    const plaintext = 'sk-proj_abc123-DEF456!@#$%^&*(){"key":"val"}';
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it("produces different ciphertext each time (random IV)", () => {
    const a = encrypt("same input");
    const b = encrypt("same input");
    expect(a).not.toBe(b); // Different IVs
    expect(decrypt(a)).toBe(decrypt(b)); // Same plaintext
  });

  it("throws on tampered ciphertext", () => {
    const encrypted = encrypt("secret");
    // Flip a character in the ciphertext portion (after IV + tag = 56 hex chars)
    const tampered = encrypted.slice(0, 60) + "ff" + encrypted.slice(62);
    expect(() => decrypt(tampered)).toThrow();
  });

  it("throws on truncated ciphertext", () => {
    const encrypted = encrypt("secret");
    expect(() => decrypt(encrypted.slice(0, 40))).toThrow();
  });
});
