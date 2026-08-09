import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  AlignmentType,
  Document,
  Footer,
  PageNumber,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import PDFDocument from "pdfkit";
import type { Meeting, TranscriptSegment } from "../../shared/types.js";

export type TranscriptExportFormat = "txt" | "md" | "docx" | "pdf";

export interface TranscriptExportInput {
  meeting: Meeting;
  segments: TranscriptSegment[];
  edition?: "verbatim" | "readable";
}

export interface TranscriptExportResult {
  filePath: string;
  downloadName: string;
  contentType: string;
}

const contentTypes: Record<TranscriptExportFormat, string> = {
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

export async function generateTranscriptExport(
  input: TranscriptExportInput,
  format: TranscriptExportFormat,
  outputDirectory: string,
): Promise<TranscriptExportResult> {
  await fs.mkdir(outputDirectory, { recursive: true });
  const filePath = path.join(outputDirectory, `transcript.${format}`);
  if (format === "txt") await fs.writeFile(filePath, `\ufeff${buildPlainText(input)}`, "utf8");
  if (format === "md") await fs.writeFile(filePath, buildMarkdown(input), "utf8");
  if (format === "docx") await fs.writeFile(filePath, await buildDocx(input));
  if (format === "pdf") await fs.writeFile(filePath, await buildPdf(input));
  return {
    filePath,
    downloadName: `${sanitizeFilename(input.meeting.title)}-${editionLabel(input.edition)}.${format}`,
    contentType: contentTypes[format],
  };
}

export function buildPlainText(input: TranscriptExportInput): string {
  const lines = [
    input.meeting.title,
    `會議開始：${formatDateTime(input.meeting.startedAt)}`,
    `錄音長度：${formatTime(input.meeting.postprocess.audioDurationMs)}`,
    `版本：${editionLabel(input.edition)}`,
    "",
  ];
  for (const segment of input.segments) {
    lines.push(`[${formatTime(segment.startMs)}] ${segment.speaker}`);
    lines.push(segment.text, "");
  }
  return `${lines.join("\r\n").trimEnd()}\r\n`;
}

export function buildMarkdown(input: TranscriptExportInput): string {
  const lines = [
    `# ${escapeMarkdown(input.meeting.title)}`,
    "",
    `- 會議開始：${formatDateTime(input.meeting.startedAt)}`,
    `- 錄音長度：${formatTime(input.meeting.postprocess.audioDurationMs)}`,
    `- 版本：${editionLabel(input.edition)}`,
    "",
    "## 逐字稿",
    "",
  ];
  for (const segment of input.segments) {
    lines.push(`**[${formatTime(segment.startMs)}] ${escapeMarkdown(segment.speaker)}**  `);
    lines.push(escapeMarkdown(segment.text), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function buildDocx(input: TranscriptExportInput): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      style: "TranscriptTitle",
      children: [new TextRun({ text: input.meeting.title, bold: true })],
    }),
    new Paragraph({
      style: "TranscriptMeta",
      children: [new TextRun(`會議開始：${formatDateTime(input.meeting.startedAt)}`)],
    }),
    new Paragraph({
      style: "TranscriptMeta",
      children: [new TextRun(`錄音長度：${formatTime(input.meeting.postprocess.audioDurationMs)}`)],
    }),
    new Paragraph({
      style: "TranscriptMeta",
      children: [new TextRun(`版本：${editionLabel(input.edition)}`)],
    }),
    new Paragraph({ style: "TranscriptHeading", children: [new TextRun({ text: "逐字稿", bold: true })] }),
  ];
  for (const segment of input.segments) {
    children.push(new Paragraph({
      style: "SpeakerLine",
      keepNext: true,
      children: [
        new TextRun({ text: `[${formatTime(segment.startMs)}] `, color: "68756F" }),
        new TextRun({ text: segment.speaker, bold: true, color: "1F5D47" }),
      ],
    }));
    children.push(new Paragraph({ style: "TranscriptBody", children: [new TextRun(segment.text)] }));
  }

  const document = new Document({
    creator: "中文會議逐字稿系統",
    title: input.meeting.title,
    description: "包含講者與時間戳的會議逐字稿",
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22, color: "17221E" },
          paragraph: { spacing: { before: 0, after: 120, line: 300 } },
        },
      },
      paragraphStyles: [
        {
          id: "TranscriptTitle",
          name: "Transcript Title",
          basedOn: "Normal",
          next: "TranscriptMeta",
          quickFormat: true,
          run: { font: "Microsoft JhengHei", size: 48, bold: true, color: "17221E" },
          paragraph: { spacing: { before: 0, after: 160 }, keepNext: true },
        },
        {
          id: "TranscriptMeta",
          name: "Transcript Metadata",
          basedOn: "Normal",
          next: "TranscriptMeta",
          run: { font: "Microsoft JhengHei", size: 20, color: "68756F" },
          paragraph: { spacing: { before: 0, after: 60 }, keepNext: true },
        },
        {
          id: "TranscriptHeading",
          name: "Transcript Heading",
          basedOn: "Normal",
          next: "SpeakerLine",
          run: { font: "Microsoft JhengHei", size: 32, bold: true, color: "2E74B5" },
          paragraph: { spacing: { before: 360, after: 200 }, keepNext: true, outlineLevel: 0 },
        },
        {
          id: "SpeakerLine",
          name: "Speaker Line",
          basedOn: "Normal",
          next: "TranscriptBody",
          run: { font: "Microsoft JhengHei", size: 18 },
          paragraph: { spacing: { before: 120, after: 40, line: 280 }, keepNext: true },
        },
        {
          id: "TranscriptBody",
          name: "Transcript Body",
          basedOn: "Normal",
          next: "SpeakerLine",
          run: { font: "Microsoft JhengHei", size: 22, color: "17221E" },
          paragraph: { spacing: { before: 0, after: 160, line: 300 } },
        },
      ],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12_240, height: 15_840 },
          margin: { top: 1_440, right: 1_440, bottom: 1_440, left: 1_440, header: 708, footer: 708 },
        },
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [
              new TextRun({ text: "會議逐字稿  |  ", color: "87928C", size: 18 }),
              new TextRun({ children: [PageNumber.CURRENT], color: "87928C", size: 18 }),
            ],
          })],
        }),
      },
      children,
    }],
  });
  return Packer.toBuffer(document);
}

async function buildPdf(input: TranscriptExportInput): Promise<Buffer> {
  const regularFont = findExistingFont([
    process.env.PDF_CJK_FONT,
    "C:\\Windows\\Fonts\\msjh.ttc",
    "C:\\Windows\\Fonts\\mingliu.ttc",
  ]);
  const boldFont = findExistingFont([
    process.env.PDF_CJK_BOLD_FONT,
    "C:\\Windows\\Fonts\\msjhbd.ttc",
    regularFont ?? undefined,
  ]);
  if (!regularFont || !boldFont) throw new Error("找不到可嵌入 PDF 的繁體中文字型");

  const pdf = new PDFDocument({ size: "LETTER", margins: { top: 72, right: 72, bottom: 72, left: 72 }, bufferPages: true, info: { Title: input.meeting.title, Author: "中文會議逐字稿系統" } });
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  const completed = new Promise<Buffer>((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  pdf.registerFont("CJK", regularFont, fontCollectionFace(regularFont));
  pdf.registerFont("CJKBold", boldFont, fontCollectionFace(boldFont));

  pdf.font("CJKBold").fontSize(24).fillColor("#17221E").text(input.meeting.title, { lineGap: 4 });
  pdf.moveDown(0.35);
  pdf.font("CJK").fontSize(10).fillColor("#68756F");
  pdf.text(`會議開始：${formatDateTime(input.meeting.startedAt)}`);
  pdf.text(`錄音長度：${formatTime(input.meeting.postprocess.audioDurationMs)}`);
  pdf.text(`版本：${editionLabel(input.edition)}`);
  pdf.moveDown(0.9);
  pdf.font("CJKBold").fontSize(16).fillColor("#2E74B5").text("逐字稿");
  pdf.moveDown(0.45);

  const contentBottom = pdf.page.height - 72 - 24;
  for (const segment of input.segments) {
    pdf.font("CJK").fontSize(11);
    const textHeight = pdf.heightOfString(segment.text, { width: pdf.page.width - 144, lineGap: 3 });
    const blockHeight = 18 + textHeight + 14;
    if (pdf.y + blockHeight > contentBottom && pdf.y > 100) pdf.addPage();
    pdf.font("CJK").fontSize(9).fillColor("#68756F").text(`[${formatTime(segment.startMs)}] `, { continued: true });
    pdf.font("CJKBold").fillColor("#1F5D47").text(segment.speaker);
    pdf.moveDown(0.25);
    pdf.font("CJK").fontSize(11).fillColor("#17221E").text(segment.text, { lineGap: 3 });
    pdf.moveDown(0.65);
  }

  const pageRange = pdf.bufferedPageRange();
  for (let index = pageRange.start; index < pageRange.start + pageRange.count; index += 1) {
    pdf.switchToPage(index);
    const bottomMargin = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    pdf.font("CJK").fontSize(8).fillColor("#87928C").text(
      `會議逐字稿  |  ${index + 1}`,
      72,
      pdf.page.height - 45,
      { width: pdf.page.width - 144, align: "right", lineBreak: false },
    );
    pdf.page.margins.bottom = bottomMargin;
  }
  pdf.end();
  return completed;
}

function findExistingFont(candidates: Array<string | undefined>): string | null {
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null;
}

function fontCollectionFace(fontPath: string): string | undefined {
  const filename = path.basename(fontPath).toLowerCase();
  if (filename === "msjh.ttc") return "MicrosoftJhengHeiRegular";
  if (filename === "msjhbd.ttc") return "MicrosoftJhengHeiBold";
  if (filename === "mingliu.ttc") return "MingLiU";
  return undefined;
}

function formatTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":")
    : [minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+.!|>-])/g, "\\$1");
}

function sanitizeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().slice(0, 80) || "會議";
}

function editionLabel(edition: TranscriptExportInput["edition"]): string {
  return edition === "readable" ? "易讀版" : "逐字版";
}
