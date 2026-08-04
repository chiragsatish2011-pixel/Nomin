import { NextResponse } from "next/server";

type Provider = "openai" | "anthropic" | "openrouter" | "nvidia" | "compatible";

const FIXED_BASES: Record<Exclude<Provider, "compatible">, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
};

function localCompatibleBase(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw.trim());
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (!local || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function safeMessage(status: number) {
  if (status === 401 || status === 403) return "That API key was not accepted. Check the key and try again.";
  if (status === 404) return "The models endpoint was not found. Check the provider address.";
  if (status === 429) return "Your provider is rate-limiting this key. Wait briefly, then try again.";
  return "The provider did not complete the connection test.";
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, error: "Connection details must be valid JSON." }, { status: 400 }); }

  const provider = body.provider;
  if (provider !== "openai" && provider !== "anthropic" && provider !== "openrouter" && provider !== "nvidia" && provider !== "compatible") {
    return NextResponse.json({ ok: false, error: "Choose a supported provider." }, { status: 400 });
  }
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) return NextResponse.json({ ok: false, error: "Enter an API key before testing the connection." }, { status: 400 });

  const baseUrl = provider === "compatible" ? localCompatibleBase(body.baseUrl) : FIXED_BASES[provider];
  if (!baseUrl) {
    return NextResponse.json({ ok: false, error: "For safety, compatible connections currently support only localhost endpoints." }, { status: 400 });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const headers: HeadersInit = provider === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${apiKey}` };
    const response = await fetch(`${baseUrl}/models`, { headers, signal: controller.signal, cache: "no-store" });
    if (!response.ok) return NextResponse.json({ ok: false, error: safeMessage(response.status) }, { status: response.status });
    const payload = await response.json() as { data?: Array<{ id?: string }>; models?: Array<{ name?: string; id?: string }> };
    const models = [
      ...(payload.data ?? []).map((entry) => entry.id),
      ...(payload.models ?? []).map((entry) => entry.id ?? entry.name),
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0).slice(0, 200);
    return NextResponse.json({ ok: true, models, baseUrl });
  } catch (error) {
    const message = error instanceof DOMException && error.name === "AbortError"
      ? "The connection test took too long. Confirm the provider is running and reachable."
      : "The provider could not be reached from Nomin.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
