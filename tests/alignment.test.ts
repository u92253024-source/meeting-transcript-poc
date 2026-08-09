import { describe, expect, it } from "vitest";
import { SpeakerTimeline } from "../src/server/alignment.js";

describe("SpeakerTimeline", () => {
  it("chooses the speaker with the largest overlap", () => {
    const timeline = new SpeakerTimeline();
    timeline.add({ startMs: 0, endMs: 1_000, speaker: "講者 1", confidence: 0.8 });
    timeline.add({ startMs: 1_000, endMs: 3_000, speaker: "講者 2", confidence: 0.9 });
    expect(timeline.findForRange(800, 2_500)?.speaker).toBe("講者 2");
  });

  it("uses a nearby observation when ranges do not overlap", () => {
    const timeline = new SpeakerTimeline();
    timeline.add({ startMs: 5_000, endMs: 6_000, speaker: "講者 3", confidence: null });
    expect(timeline.findForRange(6_100, 6_500)?.speaker).toBe("講者 3");
    expect(timeline.findForRange(20_000, 21_000)).toBeNull();
  });
});
