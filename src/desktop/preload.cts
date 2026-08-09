import { contextBridge, ipcRenderer } from "electron";
import type { DesktopSettingsInput, DesktopSettingsSummary } from "../shared/desktop-settings.js";

contextBridge.exposeInMainWorld("desktopSettings", {
  get: (): Promise<DesktopSettingsSummary> => ipcRenderer.invoke("desktop-settings:get"),
  save: (input: DesktopSettingsInput): Promise<DesktopSettingsSummary> => ipcRenderer.invoke("desktop-settings:save", input),
});
