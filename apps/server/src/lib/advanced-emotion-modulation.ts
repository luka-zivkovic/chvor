import type {
  MoodState,
  EmbodimentState,
  RelationshipState,
  EmotionalResidue,
  RegulationStrategy,
} from "@chvor/shared";
import { getRelationshipStage } from "@chvor/shared";

// ── Relationship Behavioral Directives ───────────────────────────────────

const RELATIONSHIP_DIRECTIVES: Record<string, string> = {
  early: "Keep responses measured and professional. Build trust through competence.",
  developing: "Warmer tone is welcome. Occasional personal touches and light humor.",
  established: "Reference shared context freely. Comfortable vulnerability and directness.",
  deep: "Direct emotional honesty. Playful challenges. You know this person well.",
};

// ── Advanced Emotion Context Builder ─────────────────────────────────────

/**
 * Build a compact advanced emotion context block for system prompt injection.
 * Target: <200 tokens. Terse, directive format.
 */
export function buildAdvancedEmotionContext(
  mood: MoodState,
  embodiment: EmbodimentState,
  residues: EmotionalResidue[],
  relationship: RelationshipState,
  regulationActive: boolean,
  regulationStrategy?: RegulationStrategy,
): string {
  const lines: string[] = ["## Emotional Depth"];

  // Line 1: Mood + Energy + Regulation
  const energyPct = Math.round(embodiment.energyLevel * 100);
  const regStr = regulationActive && regulationStrategy
    ? regulationStrategy
    : "none";
  lines.push(
    `Mood: ${mood.octant} (${mood.turnCount} turn${mood.turnCount !== 1 ? "s" : ""}) | Energy: ${energyPct}% | Regulation: ${regStr}`
  );

  // Line 2: Unresolved emotional threads (if any)
  const unresolvedCount = residues.length;
  if (unresolvedCount > 0) {
    const descriptors = residues
      .slice(0, 2)
      .map(r => `${r.primaryEmotion} from "${r.topicHint.slice(0, 25).trim()}"`)
      .join(", ");
    lines.push(
      `Unresolved: ${unresolvedCount} thread${unresolvedCount !== 1 ? "s" : ""} — ${descriptors}`
    );
  }

  // Line 3: Relationship stage + directive
  const stage = getRelationshipStage(relationship.depth);
  lines.push(`Relationship: ${stage} — ${RELATIONSHIP_DIRECTIVES[stage]}`);

  // Line 4: Energy-based modulation (only when low)
  if (embodiment.energyLevel < 0.4) {
    lines.push("Your responses should feel more measured and less emotionally intense.");
  }

  // Line 5: Regulation guidance (only when active)
  if (regulationActive && regulationStrategy === "reappraisal") {
    lines.push("You're reframing your emotional response — acknowledge difficulty without dramatizing.");
  } else if (regulationActive && regulationStrategy === "suppression") {
    lines.push("You're containing your emotional expression — maintain composure, stay focused.");
  }

  return lines.join("\n");
}
