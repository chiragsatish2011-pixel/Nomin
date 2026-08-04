"use client";

export type ConnectionProvider = "openai" | "anthropic" | "openrouter" | "nvidia" | "compatible";
export type ByokConfig = { provider: ConnectionProvider; apiKey: string; baseUrl: string; model: string; fastModel?: string; maxContextChars?: number; temperature?: number };
const KEY = "nomin-provider-connection";
export function readConnection(): ByokConfig | null { try { const value = sessionStorage.getItem(KEY); return value ? JSON.parse(value) as ByokConfig : null; } catch { return null; } }
export function saveConnection(config: ByokConfig) { sessionStorage.setItem(KEY, JSON.stringify(config)); window.dispatchEvent(new Event("nomin-connection-change")); }
export function clearConnection() { sessionStorage.removeItem(KEY); window.dispatchEvent(new Event("nomin-connection-change")); }
export function safeConnectionLabel(config: ByokConfig | null) { if (!config) return "Nomin hosted"; const names: Record<ConnectionProvider, string> = { openai: "OpenAI", anthropic: "Anthropic", openrouter: "OpenRouter", nvidia: "NVIDIA", compatible: "Local" }; return `Your ${names[config.provider]} connection · ${config.model}`; }
