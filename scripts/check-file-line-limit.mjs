#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const LIMIT = 1000;
const allowlistPath = ".line-limit-allowlist.json";
const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));

function matchesPattern(file, pattern) {
  if (pattern.endsWith("/**")) return file.startsWith(pattern.slice(0, -3));
  if (pattern.startsWith("**/")) return file.endsWith(pattern.slice(3));
  return file === pattern;
}

function allowReason(file) {
  for (const entry of allowlist) {
    if (matchesPattern(file, entry.path)) return entry.reason;
  }
  return null;
}

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const violations = [];
const staleAllowlist = [];
const fileSet = new Set(files);

for (const entry of allowlist) {
  if (entry.path.endsWith("/**")) {
    if (!files.some((file) => matchesPattern(file, entry.path))) staleAllowlist.push(entry.path);
  } else if (!fileSet.has(entry.path)) {
    staleAllowlist.push(entry.path);
  }
}

for (const file of files) {
  if (!existsSync(file)) continue;
  const data = readFileSync(file);
  if (data.subarray(0, 4096).includes(0)) continue;
  const lines = data.length === 0
    ? 0
    : data.toString("utf8").split("\n").length - (data[data.length - 1] === 10 ? 1 : 0);
  if (lines <= LIMIT) continue;
  const reason = allowReason(file);
  if (!reason) violations.push({ file, lines });
}

if (staleAllowlist.length > 0) {
  console.error("Stale line-limit allowlist entries:");
  for (const entry of staleAllowlist) console.error(`  - ${entry}`);
  process.exitCode = 1;
}

if (violations.length > 0) {
  console.error(`Files over ${LIMIT} lines must be decomposed or explicitly allowlisted with a strong reason:`);
  for (const { file, lines } of violations) console.error(`  - ${lines} ${file}`);
  process.exitCode = 1;
}

if (!process.exitCode) {
  console.log(`Line-limit check passed (${LIMIT} lines max for non-allowlisted text files).`);
}
