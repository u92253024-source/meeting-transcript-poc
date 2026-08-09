import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WavChunkWriter } from "../src/server/audio/wav-chunk-writer.js";
import { mergeMeetingWavChunks } from "../src/server/postprocess/merge-wav.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("WavChunkWriter", () => {
  it("writes valid headers and rotates at the configured duration", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-poc-"));
    temporaryDirectories.push(directory);
    const chunks: string[] = [];
    const writer = new WavChunkWriter(directory, {
      sampleRate: 16_000,
      chunkDurationMs: 100,
      onChunk: (chunk) => chunks.push(chunk.filename),
    });

    await writer.write(Buffer.alloc(16_000 * 2 * 0.25));
    await writer.close();

    expect(chunks).toEqual(["chunk-00001.wav", "chunk-00002.wav", "chunk-00003.wav"]);
    const first = await fs.readFile(path.join(directory, chunks[0]));
    expect(first.toString("ascii", 0, 4)).toBe("RIFF");
    expect(first.toString("ascii", 8, 12)).toBe("WAVE");
    expect(first.readUInt32LE(40)).toBe(3_200);
    expect(first.length).toBe(3_244);
  });

  it("merges finalized chunks without loading the entire meeting into memory", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-poc-"));
    temporaryDirectories.push(directory);
    const writer = new WavChunkWriter(directory, { sampleRate: 16_000, chunkDurationMs: 100 });
    await writer.write(Buffer.alloc(8_000, 7));
    await writer.close();

    const merged = await mergeMeetingWavChunks(directory);
    const audio = await fs.readFile(merged.outputPath);
    expect(merged.chunkCount).toBe(3);
    expect(merged.dataLength).toBe(8_000);
    expect(audio.readUInt32LE(40)).toBe(8_000);
    expect(audio.length).toBe(8_044);
    expect(audio.subarray(44).every((byte) => byte === 7)).toBe(true);
  });
});
