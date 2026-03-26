import { describe, it, expect } from "vitest";
import { resolveValue, resolveArray } from "./resolve";

describe("resolveValue", () => {
  it("returns literal string as-is", () => {
    expect(resolveValue({ literalString: "hello" }, {})).toBe("hello");
  });

  it("resolves a simple binding", () => {
    expect(resolveValue({ binding: "name" }, { name: "Alice" })).toBe("Alice");
  });

  it("resolves dot-path binding", () => {
    const bindings = { metrics: { cpu: 42 } };
    expect(resolveValue({ binding: "metrics.cpu" }, bindings)).toBe("42");
  });

  it("returns empty string for missing path", () => {
    expect(resolveValue({ binding: "missing.key" }, {})).toBe("");
  });

  it("returns empty string for null intermediate", () => {
    expect(resolveValue({ binding: "a.b.c" }, { a: null })).toBe("");
  });

  it("blocks __proto__ traversal", () => {
    const bindings = { __proto__: { polluted: "yes" } };
    expect(resolveValue({ binding: "__proto__.polluted" }, bindings)).toBe("");
  });

  it("blocks constructor traversal", () => {
    expect(resolveValue({ binding: "constructor.name" }, {})).toBe("");
  });

  it("blocks prototype traversal", () => {
    expect(resolveValue({ binding: "prototype.toString" }, {})).toBe("");
  });

  it("converts number to string", () => {
    expect(resolveValue({ binding: "count" }, { count: 99 })).toBe("99");
  });

  it("converts boolean to string", () => {
    expect(resolveValue({ binding: "flag" }, { flag: true })).toBe("true");
  });
});

describe("resolveArray", () => {
  it("parses literal JSON array", () => {
    const result = resolveArray({ literalString: '[{"a":1}]' }, {});
    expect(result).toEqual([{ a: 1 }]);
  });

  it("returns empty array for non-array literal JSON", () => {
    expect(resolveArray({ literalString: '{"a":1}' }, {})).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(resolveArray({ literalString: "not json" }, {})).toEqual([]);
  });

  it("resolves bound array", () => {
    const bindings = { rows: [{ x: 1 }, { x: 2 }] };
    expect(resolveArray({ binding: "rows" }, bindings)).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it("returns empty array for non-array binding", () => {
    expect(resolveArray({ binding: "name" }, { name: "Alice" })).toEqual([]);
  });

  it("resolves nested dot-path array", () => {
    const bindings = { data: { items: [1, 2, 3] } };
    expect(resolveArray({ binding: "data.items" }, bindings)).toEqual([1, 2, 3]);
  });

  it("blocks __proto__ traversal", () => {
    expect(resolveArray({ binding: "__proto__" }, {})).toEqual([]);
  });
});
