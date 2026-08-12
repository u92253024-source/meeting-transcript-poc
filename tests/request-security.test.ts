import { describe, expect, it } from "vitest";
import { AdminRateLimiter } from "../src/server/admin-rate-limit.js";
import { isLoopbackAddress } from "../src/server/request-security.js";
import { decodeAdminCredential, encodeAdminCredential } from "../src/shared/admin-credential.js";

describe("request security boundaries", () => {
  it("round-trips administrator passwords safely through ASCII-only HTTP headers", () => {
    for (const password of ["中文管理密碼-2026", "％全形＋emoji🔐", "spaces and % signs"]) {
      const encoded = encodeAdminCredential(password);
      expect(encoded).toMatch(/^[\x20-\x7e]*$/);
      expect(decodeAdminCredential(encoded)).toBe(password);
    }
    expect(decodeAdminCredential("%E0%A4%A")).toBeUndefined();
  });

  it("allows only IPv4 and IPv6 loopback addresses for local setup", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.42.1.9")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.10")).toBe(false);
    expect(isLoopbackAddress("::ffff:192.168.1.10")).toBe(false);
  });

  it("temporarily blocks repeated failed administrator attempts and resets on success", () => {
    const limiter = new AdminRateLimiter(3, 1_000, 2_000);
    limiter.recordFailure("client", 100);
    limiter.recordFailure("client", 200);
    expect(limiter.check("client", 250)).toEqual({ allowed: true });
    limiter.recordFailure("client", 300);
    expect(limiter.check("client", 400)).toEqual({ allowed: false, retryAfterSeconds: 2 });
    expect(limiter.check("client", 2_301)).toEqual({ allowed: true });
    limiter.recordFailure("client", 2_400);
    limiter.recordSuccess("client");
    expect(limiter.check("client", 2_401)).toEqual({ allowed: true });
  });
});
