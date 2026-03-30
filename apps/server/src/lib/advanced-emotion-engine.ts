import type {
  VADState,
  EmotionSnapshot,
  EmotionSignal,
  AdvancedEmotionState,
  MoodState,
  EmbodimentState,
  RelationshipState,
  EmotionalResidue,
  RegulationStrategy,
} from "@chvor/shared";
import {
  EMOTION_INERTIA,
  PERSONALITY_REGULATION,
  resolveMoodOctant,
  vadToColor,
} from "@chvor/shared";
import type { RegulationPreference } from "@chvor/shared";
import { EmotionEngine, vadDistance, vadLerp, vadScale, findClosestPrimary } from "./emotion-engine.ts";
import {
  insertResidue,
  getUnresolvedResidues as loadUnresolvedResidues,
  resolveAllResidues,
  resolveResidue,
} from "../db/emotion-residue-store.ts";

// ── Constants ────────────────────────────────────────────────────────────

const MOOD_ALPHA = 0.15;                    // EMA smoothing for mood updates
const MOOD_CONGRUENCE_STRENGTH = 0.1;       // How much mood biases emotions
const BLEED_MAX_TURN_AGE = 10;              // Turns before residue auto-resolves
const BLEED_MAX_RESIDUES = 5;               // Max unresolved residues tracked
const ENERGY_DECAY_PER_TURN = 0.03;
const ENERGY_DECAY_PER_TOOL_ROUND = 0.05;
const ENERGY_DECAY_HIGH_AROUSAL = 0.02;     // Extra decay when arousal > 0.5
const REGULATION_COST = 0.05;               // Capacity cost per regulation event
const SIGNIFICANT_SHIFT_THRESHOLD = 0.4;    // VAD distance for "significant" change

// ── Advanced Emotion Engine ──────────────────────────────────────────────

export class AdvancedEmotionEngine {
  private baseEngine: EmotionEngine;
  private presetId: string;

  // Enhancement 2: Mood layer
  private mood: MoodState;

  // Enhancement 3: Emotional residues
  private residues: EmotionalResidue[] = [];

  // Enhancement 4: Embodiment
  private embodiment: EmbodimentState = { energyLevel: 1.0, regulationCapacity: 1.0 };

  // Enhancement 5: Regulation
  private regulationPref: RegulationPreference;
  private lastRegulationActive = false;
  private lastRegulationStrategy: RegulationStrategy | undefined;

  // Enhancement 6: Relationship
  private relationship: RelationshipState;

  // Tracking
  private previousVAD: VADState | null = null;
  private sessionId: string | null = null;
  private pendingToolRounds = 0;

  constructor(baseEngine: EmotionEngine, presetId: string) {
    this.baseEngine = baseEngine;
    this.presetId = presetId;

    // Initialize mood from current engine state
    const currentVAD = baseEngine.getCurrentVAD();
    this.mood = {
      vad: { ...currentVAD },
      octant: resolveMoodOctant(currentVAD),
      since: new Date().toISOString(),
      turnCount: 0,
    };

    // Load regulation preferences for this personality
    this.regulationPref = PERSONALITY_REGULATION[presetId] ?? PERSONALITY_REGULATION.companion;

    // Default relationship (will be loaded from DB)
    const now = new Date().toISOString();
    this.relationship = {
      totalSessions: 0, totalMessages: 0,
      avgEmotionalDepth: 0, depth: 0,
      firstInteraction: now, lastInteraction: now,
    };
  }

  // ── State Loading ──────────────────────────────────────────────────────

  /** Restore mood + embodiment from a previous snapshot's advanced state */
  restoreState(snapshot: EmotionSnapshot): void {
    if (snapshot.advancedState) {
      this.mood = { ...snapshot.advancedState.mood };
      // Embodiment resets per session — don't restore
    }
  }

  /** Load unresolved emotional residues from DB */
  loadResidues(residues: EmotionalResidue[]): void {
    this.residues = residues;
  }

  /** Load relationship state from DB */
  loadRelationship(rel: RelationshipState): void {
    this.relationship = rel;
  }

  /** Set session ID for residue persistence */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /** Record tool rounds for energy calculation (called before processTurn) */
  recordToolRounds(count: number): void {
    this.pendingToolRounds += count;
  }

  // ── Getters ────────────────────────────────────────────────────────────

  getMood(): MoodState { return { ...this.mood, vad: { ...this.mood.vad } }; }
  getEmbodiment(): EmbodimentState { return { ...this.embodiment }; }
  getRelationship(): RelationshipState { return { ...this.relationship }; }
  getUnresolvedResidues(): EmotionalResidue[] { return [...this.residues]; }

  getAdvancedState(): AdvancedEmotionState {
    return {
      mood: this.getMood(),
      embodiment: this.getEmbodiment(),
      relationship: this.getRelationship(),
      unresolvedResidues: this.residues.map(r => ({ id: r.id, intensity: r.intensity })),
      regulationActive: this.lastRegulationActive,
      regulationStrategy: this.lastRegulationStrategy,
    };
  }

  // ── Enhancement 1: Per-Emotion Inertia ─────────────────────────────────

  private applyPerEmotionInertia(): void {
    // Get current dominant emotion to determine inertia
    const currentVAD = this.baseEngine.getCurrentVAD();
    // Find which primary emotion we're closest to by checking the blend
    // We use the existing engine's resolveEmotionBlend indirectly
    const { emotion } = findClosestPrimary(currentVAD);
    const inertia = EMOTION_INERTIA[emotion] ?? 0.3;
    this.baseEngine.setMomentumFactor(inertia);
  }

  // ── Enhancement 2: Mood Layer ──────────────────────────────────────────

  private updateMood(snapshot: EmotionSnapshot): void {
    // Exponential moving average
    this.mood.vad = vadLerp(this.mood.vad, snapshot.vad, MOOD_ALPHA);

    // Check if octant changed
    const newOctant = resolveMoodOctant(this.mood.vad);
    if (newOctant !== this.mood.octant) {
      this.mood.octant = newOctant;
      this.mood.since = new Date().toISOString();
      this.mood.turnCount = 0;
    } else {
      this.mood.turnCount++;
    }
  }

  /** Generate a mood-congruence signal that biases toward mood-congruent emotions */
  private generateMoodCongruenceSignal(): EmotionSignal {
    // Mood biases the system toward congruent emotions
    const bias = vadScale(this.mood.vad, MOOD_CONGRUENCE_STRENGTH);
    return {
      source: "memory_association",
      delta: bias,
      weight: 0.07, // Uses the existing reserved 7% weight
    };
  }

  // ── Enhancement 3: Emotional Memory Bleed ──────────────────────────────

  private updateResidues(snapshot: EmotionSnapshot, topicHint: string): void {
    const currentVAD = snapshot.vad;

    // Check if there was a significant emotional shift
    const shifted = this.previousVAD
      ? vadDistance(currentVAD, this.previousVAD) > SIGNIFICANT_SHIFT_THRESHOLD
      : false;

    if (shifted) {
      // Significant shift — resolve all current residues
      this.residues.forEach(r => {
        if (!r.resolved) {
          r.resolved = true;
          try { if (r.id) resolveResidue(r.id); } catch { /* best-effort */ }
        }
      });
      this.residues = this.residues.filter(r => !r.resolved);
    }

    // If current emotion is non-trivial intensity, create/update residue
    if (snapshot.blend.intensity > 0.3 && !shifted) {
      const newResidue: Omit<EmotionalResidue, "id" | "turnAge"> = {
        snapshotId: snapshot.id ?? "",
        sessionId: this.sessionId ?? "",
        vad: { ...currentVAD },
        primaryEmotion: snapshot.blend.primary.emotion,
        intensity: snapshot.blend.intensity,
        topicHint: topicHint.slice(0, 50),
        unresolvedSince: new Date().toISOString(),
        resolved: false,
      };

      // Persist and add to local list
      if (this.sessionId) {
        try {
          const id = insertResidue(newResidue);
          this.residues.push({ ...newResidue, id, turnAge: 0 });
        } catch {
          // DB failure — still track in-memory without persistence
          this.residues.push({ ...newResidue, id: "", turnAge: 0 });
        }
      }

      // Cap residues
      if (this.residues.length > BLEED_MAX_RESIDUES) {
        const oldest = this.residues.shift();
        try { if (oldest?.id) resolveResidue(oldest.id); } catch { /* best-effort */ }
      }
    }

    // Auto-resolve stale residues
    this.residues = this.residues.filter(r => {
      r.turnAge++;
      if (r.turnAge > BLEED_MAX_TURN_AGE) {
        r.resolved = true;
        try { if (r.id) resolveResidue(r.id); } catch { /* best-effort */ }
        return false;
      }
      return true;
    });
  }

  /** Generate a bleed signal from unresolved emotional residues */
  private generateBleedSignal(): EmotionSignal | null {
    if (this.residues.length === 0) return null;

    // Weighted average of residue VADs, with recency weighting
    let totalWeight = 0;
    const bleedVAD: VADState = { valence: 0, arousal: 0, dominance: 0 };

    for (const residue of this.residues) {
      // More recent residues have more bleed
      const recencyWeight = Math.max(0.1, 1 - (residue.turnAge / BLEED_MAX_TURN_AGE));
      const w = residue.intensity * recencyWeight;

      bleedVAD.valence += residue.vad.valence * w;
      bleedVAD.arousal += residue.vad.arousal * w;
      bleedVAD.dominance += residue.vad.dominance * w;
      totalWeight += w;
    }

    if (totalWeight === 0) return null;

    return {
      source: "emotional_bleed",
      delta: {
        valence: (bleedVAD.valence / totalWeight) * 0.15,  // Subtle bleed
        arousal: (bleedVAD.arousal / totalWeight) * 0.10,
        dominance: (bleedVAD.dominance / totalWeight) * 0.05,
      },
      weight: 0.05,
    };
  }

  // ── Enhancement 4: Embodied Modulation ─────────────────────────────────

  private updateEnergy(snapshot: EmotionSnapshot): void {
    // Base turn decay
    this.embodiment.energyLevel -= ENERGY_DECAY_PER_TURN;

    // Tool round decay
    if (this.pendingToolRounds > 0) {
      this.embodiment.energyLevel -= ENERGY_DECAY_PER_TOOL_ROUND * this.pendingToolRounds;
      this.pendingToolRounds = 0;
    }

    // High arousal drains extra energy
    if (snapshot.vad.arousal > 0.5) {
      this.embodiment.energyLevel -= ENERGY_DECAY_HIGH_AROUSAL;
    }

    // Clamp
    this.embodiment.energyLevel = Math.max(0, this.embodiment.energyLevel);
  }

  /** Get energy-modulated emotional range (lower energy = narrower range) */
  private getEnergyModulatedRange(): number {
    const baseRange = this.baseEngine.getGravity().emotionalRange;
    // At full energy: 100% range. At zero energy: 50% range.
    return baseRange * (0.5 + 0.5 * this.embodiment.energyLevel);
  }

  // ── Enhancement 5: Regulation Engine ───────────────────────────────────

  private applyRegulation(snapshot: EmotionSnapshot): EmotionSnapshot {
    const homeVAD = this.baseEngine.getGravity().home;
    const dist = vadDistance(snapshot.vad, homeVAD);

    this.lastRegulationActive = false;
    this.lastRegulationStrategy = undefined;

    if (dist <= this.regulationPref.thresholdDistance) {
      return snapshot; // Within threshold — no regulation needed
    }

    // Determine strategy — use primary unless capacity is too low, then try secondary
    let strategy = this.regulationPref.primary;
    if (this.embodiment.regulationCapacity < 0.2 && strategy !== "acceptance") {
      strategy = this.regulationPref.secondary;
    }

    this.lastRegulationActive = true;
    this.lastRegulationStrategy = strategy;

    // Apply regulation
    const regulated = { ...snapshot };

    switch (strategy) {
      case "reappraisal": {
        // Cognitively reframe: lerp VAD toward home
        const strength = this.regulationPref.reappraisalStrength * this.embodiment.regulationCapacity;
        regulated.vad = vadLerp(snapshot.vad, homeVAD, strength);
        // Re-derive color
        regulated.color = vadToColor(regulated.vad);
        break;
      }
      case "suppression": {
        // Keep internal VAD but reduce display intensity
        const suppression = this.regulationPref.suppressionStrength * this.embodiment.regulationCapacity;
        regulated.blend = {
          ...snapshot.blend,
          intensity: snapshot.blend.intensity * (1 - suppression),
        };
        break;
      }
      case "acceptance":
        // No modification — emotion is accepted as-is
        break;
    }

    // Regulation costs capacity
    if (strategy !== "acceptance") {
      this.embodiment.regulationCapacity = Math.max(
        0,
        this.embodiment.regulationCapacity - REGULATION_COST,
      );
    }

    return regulated;
  }

  // ── Main Entry Point ───────────────────────────────────────────────────

  /**
   * Process a full turn through the advanced emotion pipeline.
   * Wraps the base engine and adds all 6 enhancements.
   */
  processTurn(signals: EmotionSignal[], topicHint: string): EmotionSnapshot {
    // Enhancement 1: Set per-emotion inertia before base engine runs
    this.applyPerEmotionInertia();

    // Enhancement 2: Generate mood congruence signal
    const moodSignal = this.generateMoodCongruenceSignal();

    // Enhancement 3: Generate bleed signal from unresolved residues
    const bleedSignal = this.generateBleedSignal();

    // Combine all signals
    const allSignals = [...signals, moodSignal];
    if (bleedSignal) allSignals.push(bleedSignal);

    // Run base engine pipeline
    let snapshot = this.baseEngine.processTurn(allSignals);

    // Enhancement 5: Apply regulation
    snapshot = this.applyRegulation(snapshot);

    // Enhancement 4: Update energy (after processing, based on result)
    this.updateEnergy(snapshot);

    // Enhancement 4: Modulate intensity by energy level
    if (this.embodiment.energyLevel < 0.5) {
      const energyFactor = 0.5 + 0.5 * (this.embodiment.energyLevel / 0.5);
      snapshot.blend = {
        ...snapshot.blend,
        intensity: snapshot.blend.intensity * energyFactor,
      };
    }

    // Enhancement 2: Update mood layer
    this.updateMood(snapshot);

    // Enhancement 3: Update residues
    this.previousVAD = { ...snapshot.vad };
    this.updateResidues(snapshot, topicHint);

    // Attach advanced state to snapshot
    snapshot.advancedState = this.getAdvancedState();

    return snapshot;
  }
}

// ── Factory ──────────────────────────────────────────────────────────────

export function createAdvancedEmotionEngine(
  baseEngine: EmotionEngine,
  presetId: string,
): AdvancedEmotionEngine {
  return new AdvancedEmotionEngine(baseEngine, presetId);
}
