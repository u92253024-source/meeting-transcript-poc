import { describe, expect, it } from "vitest";
import { parseByteRange } from "../src/server/audio/range.js";

describe("audio byte ranges", () => {
  it("supports bounded, open-ended, and suffix ranges", () => {
    expect(parseByteRange("bytes=100-199", 1_000)).toEqual({ start: 100, end: 199 });
    expect(parseByteRange("bytes=900-", 1_000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange("bytes=-100", 1_000)).toEqual({ start: 900, end: 999 });
  });

  it("rejects ranges outside the recording", () => {
    expect(parseByteRange("bytes=1000-", 1_000)).toBe("invalid");
    expect(parseByteRange("items=0-10", 1_000)).toBe("invalid");
  });
});
