/**
 * Paths the agent must never receive as ordinary workspace context.
 *
 * Tool validation already rejects these at execution time, but snapshots and
 * attachments are also model-facing context. Filtering them at input time
 * prevents filename-level secret metadata from reaching planning/synthesis in
 * the first place.
 */
export function isSensitiveWorkspacePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "secrets" || segment === ".aws")) return true;
  const name = segments.at(-1) ?? "";
  return name === ".env" ||
    /^\.env\.(?:local|development|production|test)$/.test(name) ||
    /^\.env\..+\.local$/.test(name) ||
    /(?:^|\.)\b(?:pem|key|p12|pfx)\b$/.test(name) ||
    name === "id_rsa" || name === "id_ed25519";
}
