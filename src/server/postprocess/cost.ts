export function estimateAssemblyCostUsd(
  audioDurationMs: number,
  baseUsdPerHour: number,
  diarizationUsdPerHour: number,
): number {
  const hours = Math.max(0, audioDurationMs) / 3_600_000;
  return Math.round(hours * (baseUsdPerHour + diarizationUsdPerHour) * 1_000_000) / 1_000_000;
}
