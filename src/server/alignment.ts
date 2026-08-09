import type { TranscriptSegment } from "../shared/types.js";

export interface SpeakerObservation {
  startMs: number;
  endMs: number;
  speaker: string;
  confidence: number | null;
}

export class SpeakerTimeline {
  private readonly observations: SpeakerObservation[] = [];

  add(observation: SpeakerObservation): void {
    this.observations.push(observation);
    this.observations.sort((a, b) => a.startMs - b.startMs);
    if (this.observations.length > 1_000) this.observations.splice(0, 200);
  }

  findForRange(startMs: number, endMs: number): SpeakerObservation | null {
    let best: SpeakerObservation | null = null;
    let bestOverlap = 0;
    for (const candidate of this.observations) {
      const overlap = Math.max(0, Math.min(endMs, candidate.endMs) - Math.max(startMs, candidate.startMs));
      if (overlap > bestOverlap) {
        best = candidate;
        bestOverlap = overlap;
      }
    }
    if (best) return best;

    const midpoint = (startMs + endMs) / 2;
    let nearestDistance = 5_001;
    for (const candidate of this.observations) {
      const candidateMidpoint = (candidate.startMs + candidate.endMs) / 2;
      const distance = Math.abs(midpoint - candidateMidpoint);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        best = candidate;
      }
    }
    return nearestDistance <= 5_000 ? best : null;
  }

  segmentsAffectedBy(observation: SpeakerObservation, segments: TranscriptSegment[]): TranscriptSegment[] {
    return segments.filter((segment) => {
      const overlap = Math.max(
        0,
        Math.min(segment.endMs, observation.endMs) - Math.max(segment.startMs, observation.startMs),
      );
      return overlap > 0 || Math.abs((segment.startMs + segment.endMs - observation.startMs - observation.endMs) / 2) <= 2_000;
    });
  }
}
