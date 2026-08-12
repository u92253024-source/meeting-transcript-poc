import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  desktopTranscriptionModes,
  type DesktopSettingsInput,
  type DesktopSettingsSummary,
  type DesktopTranscriptionMode,
} from "../shared/desktop-settings.js";
import { encodeAdminCredential } from "../shared/admin-credential.js";

interface StoredDesktopSettings {
  transcriptionMode?: DesktopTranscriptionMode;
  googleCloudProject?: string;
  encryptedSecrets?: Partial<Record<"deepgram" | "assembly" | "gemini", string>>;
}

let serverProcess: ChildProcess | undefined;
let serverUrl = "";
let mainWindow: BrowserWindow | undefined;
const desktopDirectory = path.dirname(fileURLToPath(import.meta.url));

function selectPort(): number {
  return 32_000 + randomInt(1_000);
}

function settingsPath(): string {
  return path.join(app.getPath("userData"), "desktop-settings.json");
}

async function readStoredSettings(): Promise<StoredDesktopSettings> {
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath(), "utf8")) as StoredDesktopSettings;
    return {
      transcriptionMode: desktopTranscriptionModes.includes(parsed.transcriptionMode as DesktopTranscriptionMode)
        ? parsed.transcriptionMode
        : "mock",
      googleCloudProject: typeof parsed.googleCloudProject === "string" ? parsed.googleCloudProject : "",
      encryptedSecrets: parsed.encryptedSecrets ?? {},
    };
  } catch {
    return { transcriptionMode: "mock", googleCloudProject: "", encryptedSecrets: {} };
  }
}

async function writeStoredSettings(settings: StoredDesktopSettings): Promise<void> {
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  const temporaryPath = `${settingsPath()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(settings, null, 2), "utf8");
  await fs.rename(temporaryPath, settingsPath());
}

function decryptSecret(settings: StoredDesktopSettings, key: "deepgram" | "assembly" | "gemini"): string {
  const encrypted = settings.encryptedSecrets?.[key];
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    return "";
  }
}

function toSummary(settings: StoredDesktopSettings): DesktopSettingsSummary {
  return {
    isDesktop: true,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    transcriptionMode: settings.transcriptionMode ?? "mock",
    googleCloudProject: settings.googleCloudProject ?? "",
    deepgramConfigured: Boolean(decryptSecret(settings, "deepgram")),
    assemblyAiConfigured: Boolean(decryptSecret(settings, "assembly")),
    geminiConfigured: Boolean(decryptSecret(settings, "gemini")),
  };
}

function normalizeSettingsInput(value: unknown): DesktopSettingsInput {
  if (!value || typeof value !== "object") throw new Error("設定格式錯誤");
  const input = value as Partial<DesktopSettingsInput>;
  if (typeof input.adminPassword !== "string" || !input.adminPassword) throw new Error("請輸入管理密碼");
  if (!desktopTranscriptionModes.includes(input.transcriptionMode as DesktopTranscriptionMode)) throw new Error("不支援的辨識模式");
  const normalize = (text: unknown): string | undefined => typeof text === "string" ? text.trim() : undefined;
  return {
    adminPassword: input.adminPassword,
    transcriptionMode: input.transcriptionMode as DesktopTranscriptionMode,
    googleCloudProject: normalize(input.googleCloudProject) ?? "",
    deepgramApiKey: normalize(input.deepgramApiKey),
    assemblyAiApiKey: normalize(input.assemblyAiApiKey),
    geminiApiKey: normalize(input.geminiApiKey),
    clearDeepgramApiKey: input.clearDeepgramApiKey === true,
    clearAssemblyAiApiKey: input.clearAssemblyAiApiKey === true,
    clearGeminiApiKey: input.clearGeminiApiKey === true,
  };
}

function updateEncryptedSecret(
  settings: StoredDesktopSettings,
  key: "deepgram" | "assembly" | "gemini",
  value: string | undefined,
  clear: boolean | undefined,
): void {
  settings.encryptedSecrets ??= {};
  if (clear) delete settings.encryptedSecrets[key];
  else if (value) settings.encryptedSecrets[key] = safeStorage.encryptString(value).toString("base64");
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`本機逐字稿服務未能啟動：${lastError || "逾時"}`);
}

async function startLocalServer(): Promise<string> {
  const port = selectPort();
  const settings = await readStoredSettings();
  const appRoot = app.getAppPath();
  const serverEntry = path.join(appRoot, "dist-server", "server", "index.js");
  const userData = app.getPath("userData");
  const child = spawn(process.execPath, [serverEntry], {
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      APP_ROOT: appRoot,
      DATA_DIR: path.join(userData, "data"),
      DOTENV_CONFIG_PATH: path.join(userData, "desktop-unused.env"),
      HOST: "0.0.0.0",
      PORT: String(port),
      TRANSCRIPTION_MODE: settings.transcriptionMode ?? "mock",
      GOOGLE_CLOUD_PROJECT: settings.googleCloudProject ?? "",
      DEEPGRAM_API_KEY: decryptSecret(settings, "deepgram"),
      ASSEMBLYAI_API_KEY: decryptSecret(settings, "assembly"),
      GEMINI_API_KEY: decryptSecret(settings, "gemini"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => console.error(`[meeting-server] ${chunk.toString()}`));
  child.on("exit", (code) => {
    if (serverProcess === child) console.error(`[meeting-server] exited with code ${code ?? "unknown"}`);
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(url);
  } catch (error) {
    child.kill();
    throw error;
  }
  serverProcess = child;
  serverUrl = url;
  return url;
}

async function stopLocalServer(): Promise<void> {
  const child = serverProcess;
  serverProcess = undefined;
  serverUrl = "";
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit").then(() => undefined);
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

async function verifyAdminPassword(password: string): Promise<void> {
  if (!serverUrl) throw new Error("本機服務尚未啟動");
  const response = await fetch(`${serverUrl}/api/admin/verify`, {
    method: "POST",
    headers: { "x-admin-password-encoded": encodeAdminCredential(password) },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? `管理密碼驗證失敗（HTTP ${response.status}）`);
  }
}

ipcMain.handle("desktop-settings:get", async (): Promise<DesktopSettingsSummary> => toSummary(await readStoredSettings()));

ipcMain.handle("desktop-settings:save", async (_event, rawInput: unknown): Promise<DesktopSettingsSummary> => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 加密儲存無法使用，未儲存 API 設定");
  const input = normalizeSettingsInput(rawInput);
  await verifyAdminPassword(input.adminPassword);
  const settings = await readStoredSettings();
  settings.transcriptionMode = input.transcriptionMode;
  settings.googleCloudProject = input.googleCloudProject;
  updateEncryptedSecret(settings, "deepgram", input.deepgramApiKey, input.clearDeepgramApiKey);
  updateEncryptedSecret(settings, "assembly", input.assemblyAiApiKey, input.clearAssemblyAiApiKey);
  updateEncryptedSecret(settings, "gemini", input.geminiApiKey, input.clearGeminiApiKey);
  await writeStoredSettings(settings);
  await stopLocalServer();
  const nextUrl = await startLocalServer();
  await mainWindow?.loadURL(nextUrl);
  return toSummary(settings);
});

function createWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: 1_320,
    height: 920,
    minWidth: 1_020,
    minHeight: 700,
    autoHideMenuBar: true,
    title: "中文會議逐字稿",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Sandboxed Electron preloads must use CommonJS.  An ESM preload silently
      // fails before it can expose contextBridge on some Windows builds.
      preload: path.join(desktopDirectory, "preload.cjs"),
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });
  void mainWindow.loadURL(url);
}

app.whenReady().then(async () => {
  try {
    createWindow(await startLocalServer());
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      title: "中文會議逐字稿無法啟動",
      message: error instanceof Error ? error.message : String(error),
    });
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  serverProcess?.kill();
  serverProcess = undefined;
});
