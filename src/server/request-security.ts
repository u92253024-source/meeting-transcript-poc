import { isIP } from "node:net";

export function isLoopbackAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  if (normalized === "::1") return true;

  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  if (isIP(ipv4) !== 4) return false;
  return Number(ipv4.split(".", 1)[0]) === 127;
}
