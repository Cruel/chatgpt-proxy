export function normalizeThreadName(name: string): string {
  return name.normalize("NFKC").trim().replaceAll(/\s+/g, " ").toLowerCase();
}
