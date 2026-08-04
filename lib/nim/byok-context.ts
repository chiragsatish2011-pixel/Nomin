import { AsyncLocalStorage } from "node:async_hooks";
export type ByokProviderConfig = { provider: "openai" | "anthropic" | "openrouter" | "nvidia" | "compatible"; apiKey: string; baseUrl: string; model: string; fastModel?: string; maxContextChars?: number; temperature?: number };
const context = new AsyncLocalStorage<ByokProviderConfig>();
export const withByokProvider = <T>(config: ByokProviderConfig | undefined, run: () => Promise<T>) => config ? context.run(config, run) : run();
export const currentByokProvider = () => context.getStore();
