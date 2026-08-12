export function encodeAdminCredential(password: string): string {
  return encodeURIComponent(password);
}

export function decodeAdminCredential(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
