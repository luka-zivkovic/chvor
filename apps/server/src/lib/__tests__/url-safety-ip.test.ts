import { describe, it, expect } from "vitest";
import { isPrivateIp } from "../url-safety.ts";

describe("isPrivateIp — IPv4", () => {
  it("flags RFC1918 / loopback / link-local / CGNAT / multicast", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.1.1",
      "0.0.0.0",
      "100.64.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "172.15.0.1"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});

describe("isPrivateIp — IPv6 (the previously-missed cases)", () => {
  it("flags loopback / unspecified", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("::")).toBe(true);
  });

  it("flags IPv4-mapped IPv6 pointing at private space", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:192.168.0.1")).toBe(true);
    // mapped public stays allowed
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
  });

  it("flags deprecated IPv4-compatible IPv6 (::a.b.c.d) pointing at private space", () => {
    expect(isPrivateIp("::127.0.0.1")).toBe(true);
    expect(isPrivateIp("::169.254.169.254")).toBe(true); // cloud metadata
    expect(isPrivateIp("::10.0.0.1")).toBe(true);
    // compatible public stays allowed
    expect(isPrivateIp("::8.8.8.8")).toBe(false);
  });

  it("flags ULA fc00::/7 including fd00::/8 (regex previously missed fd)", () => {
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fd12:3456:789a::1")).toBe(true);
    expect(isPrivateIp("fdff::")).toBe(true);
  });

  it("flags the whole link-local fe80::/10 range (regex previously missed fe9x/feax/febx)", () => {
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("fe90::1")).toBe(true);
    expect(isPrivateIp("fea0::1")).toBe(true);
    expect(isPrivateIp("febf::1")).toBe(true);
    // fec0:: is outside fe80::/10
    expect(isPrivateIp("fec0::1")).toBe(false);
  });

  it("does not flag a public IPv6 (e.g. fe8 hextet is NOT link-local)", () => {
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateIp("fe8::1")).toBe(false); // 0x0fe8, not fe80::/10
  });
});
