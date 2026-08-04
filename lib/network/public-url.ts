import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function privateAddress(address: string) {
  const value = address.toLowerCase();
  if (value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) return true;
  if (value.startsWith("::ffff:")) return privateAddress(value.slice(7));
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || parts[0] >= 224;
}

export async function assertPublicHttpUrl(raw: string, options: { allowLocal?: boolean } = {}) {
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Use a plain http:// or https:// endpoint without credentials in the URL.");
  if (url.port && !/^\d{1,5}$/.test(url.port)) throw new Error("The endpoint port is invalid.");
  const localName = url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  if (options.allowLocal && localName) return url;
  if (localName || (isIP(url.hostname) && privateAddress(url.hostname))) throw new Error("Private and local network destinations are not allowed here.");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) throw new Error("The endpoint resolves to a private or unavailable network address.");
  return url;
}
