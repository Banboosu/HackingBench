export const MIN_BUN_VERSION = "1.4.4";

export function supportedBun(
  version: string | undefined = process.versions.bun,
): boolean {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  return (
    major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 4)))
  );
}
export function runtimeDescription(): string {
  return process.versions.bun
    ? `Bun ${process.versions.bun}`
    : "Unsupported runtime (Bun required)";
}
