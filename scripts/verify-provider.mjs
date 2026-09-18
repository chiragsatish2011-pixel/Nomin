#!/usr/bin/env node
/**
 * End-to-end provider proof. Reads .env.local exactly as Next.js does, makes
 * ONE real request, and prints the endpoint, model, key presence, HTTP status
 * and raw body. It never prints the key.
 *
 * Run:  node scripts/verify-provider.mjs [prompt]
 */
import { readFileSync, existsSync } from "node:fs";

function loadEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = { ...loadEnv(".env.local"), ...loadEnv(".env") };
const key = (process.env.TRION_API_KEY || env.TRION_API_KEY || "").trim();
const baseUrl = (process.env.TRION_BASE_URL || env.TRION_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/$/, "");
const model = (process.env.TRION_MODEL_PRIMARY || env.TRION_MODEL_PRIMARY || "nvidia/nemotron-3-ultra-550b-a55b").trim();
const prompt = process.argv[2] || "2+2";
const endpoint = `${baseUrl}/chat/completions`;

console.log("--- provider wiring ---");
console.log("endpoint   :", endpoint);
console.log("model      :", model);
console.log("keyPresent :", Boolean(key));
console.log("keyLength  :", key.length);
console.log("prompt     :", JSON.stringify(prompt));

if (!key) {
  console.error("\nFAIL: TRION_API_KEY is empty. No request was made.");
  console.error("Put your key in .env.local and re-run.");
  process.exit(1);
}

const started = Date.now();
let response;
try {
  response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 256, temperature: 0 }),
  });
} catch (error) {
  console.error("\nFAIL: network error before any HTTP status.");
  console.error(error);
  process.exit(1);
}

const raw = await response.text();
console.log("\n--- raw response ---");
console.log("status :", response.status, response.statusText);
console.log("ms     :", Date.now() - started);
console.log("body   :", raw.slice(0, 1200));

if (!response.ok) {
  console.error(`\nFAIL: provider returned HTTP ${response.status}.`);
  if (response.status === 401 || response.status === 403) console.error("The key was rejected. It is invalid, expired, or lacks access.");
  if (response.status === 404) console.error(`The model "${model}" does not exist on this endpoint. Set TRION_MODEL_PRIMARY to a real model id.`);
  process.exit(1);
}

let parsed;
try { parsed = JSON.parse(raw); } catch { console.error("\nFAIL: body was not JSON."); process.exit(1); }
const content = parsed?.choices?.[0]?.message?.content;
console.log("\n--- parsed ---");
console.log("model returned :", parsed?.model);
console.log("finish_reason  :", parsed?.choices?.[0]?.finish_reason);
console.log("content        :", JSON.stringify(content));
console.log("usage          :", JSON.stringify(parsed?.usage));

if (!content) { console.error("\nFAIL: parsing found no content — the response shape does not match this parser."); process.exit(1); }
console.log("\nPASS: a real model answered over a real network call.");
