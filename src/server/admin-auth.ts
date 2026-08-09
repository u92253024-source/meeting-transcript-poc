import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { TranscriptDatabase } from "./database.js";

const SETTING_KEY = "admin_password_hash";

export class AdminAuth {
  constructor(private readonly database: TranscriptDatabase, bootstrapPassword: string) {
    if (!this.isConfigured && bootstrapPassword && bootstrapPassword !== "change-me") {
      this.configure(bootstrapPassword);
    }
  }

  get isConfigured(): boolean {
    return Boolean(this.database.getSetting(SETTING_KEY));
  }

  verify(password: string | string[] | undefined): boolean {
    if (typeof password !== "string" || !this.isConfigured) return false;
    const stored = this.database.getSetting(SETTING_KEY);
    if (!stored) return false;
    const [scheme, salt, expected] = stored.split("$");
    if (scheme !== "scrypt" || !salt || !expected) return false;
    const derived = scryptSync(password, Buffer.from(salt, "base64"), 64);
    const expectedBuffer = Buffer.from(expected, "base64");
    return expectedBuffer.length === derived.length && timingSafeEqual(expectedBuffer, derived);
  }

  configure(password: string): void {
    const salt = randomBytes(16);
    const derived = scryptSync(password, salt, 64);
    this.database.setSetting(SETTING_KEY, `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`);
  }
}
