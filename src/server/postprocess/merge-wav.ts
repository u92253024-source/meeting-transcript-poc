import fs from "node:fs/promises";
import path from "node:path";

interface WavFormat {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
}

export interface MergedWav {
  outputPath: string;
  chunkCount: number;
  dataLength: number;
}

export async function mergeMeetingWavChunks(audioDirectory: string): Promise<MergedWav> {
  const filenames = (await fs.readdir(audioDirectory))
    .filter((filename) => /^chunk-\d{5}\.wav$/.test(filename))
    .sort();
  if (filenames.length === 0) throw new Error("找不到可供會後處理的錄音分段");

  const chunks: Array<{ filePath: string; dataLength: number }> = [];
  let expectedFormat: WavFormat | null = null;
  let totalDataLength = 0;
  for (const filename of filenames) {
    const filePath = path.join(audioDirectory, filename);
    const handle = await fs.open(filePath, "r");
    try {
      const header = Buffer.alloc(44);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (bytesRead !== 44 || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
        throw new Error(`錄音分段格式不正確：${filename}`);
      }
      const format: WavFormat = {
        audioFormat: header.readUInt16LE(20),
        channels: header.readUInt16LE(22),
        sampleRate: header.readUInt32LE(24),
        byteRate: header.readUInt32LE(28),
        blockAlign: header.readUInt16LE(32),
        bitsPerSample: header.readUInt16LE(34),
      };
      if (format.audioFormat !== 1 || header.toString("ascii", 36, 40) !== "data") {
        throw new Error(`錄音分段不是標準 PCM WAV：${filename}`);
      }
      if (expectedFormat && JSON.stringify(format) !== JSON.stringify(expectedFormat)) {
        throw new Error(`錄音分段格式不一致：${filename}`);
      }
      expectedFormat ??= format;
      const stat = await handle.stat();
      const declaredDataLength = header.readUInt32LE(40);
      const availableDataLength = Math.max(0, stat.size - 44);
      if (declaredDataLength !== availableDataLength) throw new Error(`錄音分段長度不正確：${filename}`);
      chunks.push({ filePath, dataLength: declaredDataLength });
      totalDataLength += declaredDataLength;
    } finally {
      await handle.close();
    }
  }

  if (!expectedFormat) throw new Error("無法判斷錄音格式");
  if (totalDataLength > 0xffff_ffff - 36) throw new Error("合併錄音超過 WAV 格式大小上限");

  const outputPath = path.join(audioDirectory, "meeting-combined.wav");
  const temporaryPath = `${outputPath}.part`;
  const output = await fs.open(temporaryPath, "w");
  try {
    await output.write(createWavHeader(expectedFormat, totalDataLength));
    const buffer = Buffer.alloc(1024 * 1024);
    for (const chunk of chunks) {
      const input = await fs.open(chunk.filePath, "r");
      try {
        let position = 44;
        let remaining = chunk.dataLength;
        while (remaining > 0) {
          const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, remaining), position);
          if (bytesRead === 0) throw new Error(`讀取錄音分段時提前結束：${path.basename(chunk.filePath)}`);
          await output.write(buffer, 0, bytesRead);
          position += bytesRead;
          remaining -= bytesRead;
        }
      } finally {
        await input.close();
      }
    }
    await output.sync();
  } catch (error) {
    await output.close();
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
  await output.close();
  await fs.rm(outputPath, { force: true });
  await fs.rename(temporaryPath, outputPath);
  return { outputPath, chunkCount: chunks.length, dataLength: totalDataLength };
}

function createWavHeader(format: WavFormat, dataLength: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(format.audioFormat, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.byteRate, 28);
  header.writeUInt16LE(format.blockAlign, 32);
  header.writeUInt16LE(format.bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}
