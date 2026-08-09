import fs from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";

export interface AudioChunkInfo {
  filename: string;
  startMs: number;
  endMs: number;
}

export interface WavChunkWriterOptions {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  chunkDurationMs?: number;
  onChunk?: (chunk: AudioChunkInfo) => void;
}

export class WavChunkWriter {
  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly bitsPerSample: number;
  private readonly chunkDurationMs: number;
  private readonly onChunk?: (chunk: AudioChunkInfo) => void;
  private handle: FileHandle | null = null;
  private chunkIndex = 0;
  private chunkBytes = 0;
  private totalBytes = 0;
  private currentPath = "";

  constructor(private readonly directory: string, options: WavChunkWriterOptions = {}) {
    this.sampleRate = options.sampleRate ?? 16_000;
    this.channels = options.channels ?? 1;
    this.bitsPerSample = options.bitsPerSample ?? 16;
    this.chunkDurationMs = options.chunkDurationMs ?? 5 * 60_000;
    this.onChunk = options.onChunk;
  }

  async write(buffer: Buffer): Promise<void> {
    let offset = 0;
    const maxBytes = this.bytesForMs(this.chunkDurationMs);
    while (offset < buffer.length) {
      if (!this.handle) await this.openChunk();
      const available = maxBytes - this.chunkBytes;
      const length = Math.min(available, buffer.length - offset);
      await this.handle!.write(buffer.subarray(offset, offset + length));
      this.chunkBytes += length;
      this.totalBytes += length;
      offset += length;
      if (this.chunkBytes >= maxBytes) await this.finalizeChunk();
    }
  }

  get durationMs(): number {
    return this.msForBytes(this.totalBytes);
  }

  async close(): Promise<void> {
    if (this.handle) await this.finalizeChunk();
  }

  private async openChunk(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    this.chunkIndex += 1;
    const filename = `chunk-${String(this.chunkIndex).padStart(5, "0")}.wav`;
    this.currentPath = path.join(this.directory, filename);
    this.handle = await fs.open(`${this.currentPath}.part`, "w+");
    await this.handle.write(Buffer.alloc(44));
    this.chunkBytes = 0;
  }

  private async finalizeChunk(): Promise<void> {
    if (!this.handle) return;
    const endMs = this.durationMs;
    const startMs = endMs - this.msForBytes(this.chunkBytes);
    await this.handle.write(this.createHeader(this.chunkBytes), 0, 44, 0);
    await this.handle.sync();
    await this.handle.close();
    await fs.rename(`${this.currentPath}.part`, this.currentPath);
    const info = { filename: path.basename(this.currentPath), startMs, endMs };
    this.handle = null;
    this.chunkBytes = 0;
    this.onChunk?.(info);
  }

  private bytesForMs(ms: number): number {
    return Math.floor((ms / 1000) * this.sampleRate * this.channels * (this.bitsPerSample / 8));
  }

  private msForBytes(bytes: number): number {
    return Math.round((bytes / (this.sampleRate * this.channels * (this.bitsPerSample / 8))) * 1000);
  }

  private createHeader(dataLength: number): Buffer {
    const blockAlign = this.channels * (this.bitsPerSample / 8);
    const byteRate = this.sampleRate * blockAlign;
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(this.channels, 22);
    header.writeUInt32LE(this.sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(this.bitsPerSample, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataLength, 40);
    return header;
  }
}
