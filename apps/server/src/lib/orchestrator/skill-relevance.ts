import type { Skill } from "@chvor/shared";

const NOISE_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "to",
  "in",
  "on",
  "for",
  "with",
  "via",
  "of",
  "is",
  "by",
]);

/** Lightweight keyword overlap check used to select workflow skills. */
export function isWorkflowRelevant(skill: Skill, query: string): boolean {
  if (!query) return false;
  const { name, description, tags, needs } = skill.metadata;
  const keywords = [
    ...name.toLowerCase().split(/\s+/),
    ...description.toLowerCase().split(/\s+/),
    ...(tags?.map((tag) => tag.toLowerCase()) ?? []),
    ...(needs?.map((need) => need.split(":")[0].toLowerCase()) ?? []),
  ];

  return keywords
    .filter((keyword) => keyword.length > 2 && !NOISE_WORDS.has(keyword))
    .some((keyword) => query.includes(keyword));
}
