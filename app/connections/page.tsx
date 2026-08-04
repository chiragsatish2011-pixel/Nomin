"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";
import { Check, KeyRound, MessageSquareText, PanelLeftClose, PanelLeftOpen, Plug, Search, Unplug } from "lucide-react";
import { AccountMenu } from "@/app/components/AccountMenu";
import { AccountRouteGuard } from "@/app/components/AccountRouteGuard";
import { JellyfishMark } from "@/app/components/JellyfishMark";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { clearConnection, readConnection, safeConnectionLabel, saveConnection, type ByokConfig, type ConnectionProvider } from "@/app/lib/byok-client";

const PROVIDERS: Array<{ id: ConnectionProvider; name: string; description: string }> = [
  { id: "openai", name: "OpenAI", description: "Connect a key from your OpenAI account." },
  { id: "anthropic", name: "Anthropic", description: "Connect a key from your Anthropic account." },
  { id: "openrouter", name: "OpenRouter", description: "Choose from the models available through your OpenRouter key." },
  { id: "nvidia", name: "NVIDIA", description: "Connect your API Catalog key and choose an available model." },
  { id: "compatible", name: "OpenAI-compatible", description: "Connect a local service that follows the OpenAI API shape." },
];

function ConnectionsPageContent() {
  const [sidebarOpen, setSidebarOpenState] = useState(() => {
    if (typeof window === "undefined") return true;
    const saved = localStorage.getItem("nomin-sidebar-collapsed");
    return saved !== "1" && !(saved === null && window.innerWidth <= 720);
  });
  const [provider, setProvider] = useState<ConnectionProvider>("openai");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [fastModel, setFastModel] = useState("");
  const [maxContextChars, setMaxContextChars] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" | "testing" | "success" | "error"; message: string }>({ kind: "idle", message: "" });
  const [active, setActive] = useState<ByokConfig | null>(() => typeof window === "undefined" ? null : readConnection());
  const filteredModels = useMemo(() => models.filter((entry) => entry.toLowerCase().includes(query.toLowerCase())), [models, query]);
  const setSidebarOpen = (open: boolean) => { setSidebarOpenState(open); localStorage.setItem("nomin-sidebar-collapsed", open ? "0" : "1"); };

  async function validate(event: FormEvent) {
    event.preventDefault();
    setStatus({ kind: "testing", message: "Testing this connection…" });
    const response = await fetch("/api/trion/connections/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, apiKey, baseUrl }) });
    const result = await response.json() as { ok?: boolean; error?: string; models?: string[]; baseUrl?: string };
    if (!response.ok || !result.ok) { setStatus({ kind: "error", message: result.error ?? "The connection test failed." }); return; }
    const discovered = result.models ?? [];
    setModels(discovered);
    const selected = model || discovered[0] || "";
    setModel(selected);
    if (result.baseUrl) setBaseUrl(result.baseUrl);
    setStatus({ kind: "success", message: discovered.length ? `Connected. ${discovered.length} models are available.` : "Connected. Enter the model name your provider expects." });
  }

  function activate() {
    if (status.kind !== "success" || !model.trim()) { setStatus({ kind: "error", message: "Test the connection and choose a model before activating it." }); return; }
    const fixedBase = provider === "openai" ? "https://api.openai.com/v1" : provider === "anthropic" ? "https://api.anthropic.com/v1" : provider === "openrouter" ? "https://openrouter.ai/api/v1" : provider === "nvidia" ? "https://integrate.api.nvidia.com/v1" : baseUrl.trim();
    const config: ByokConfig = { provider, apiKey: apiKey.trim(), baseUrl: fixedBase, model: model.trim(), ...(fastModel.trim() ? { fastModel: fastModel.trim() } : {}), ...(maxContextChars ? { maxContextChars: Number(maxContextChars) } : {}) };
    saveConnection(config); setActive(config); setStatus({ kind: "success", message: "Your connection is active for new messages in this browser tab." });
  }

  function disconnect() { clearConnection(); setActive(null); setApiKey(""); setStatus({ kind: "idle", message: "Switched back to Nomin hosted." }); }

  return <main className={`connectionsShell${sidebarOpen ? "" : " sidebarClosed"}`}>
    <aside className="capacitySidebar connectionsSidebar">
      <div className="capacitySidebarHead"><Link className="capacityBrand" href="/"><JellyfishMark size={38} title="Nomin" /><strong className="nominWordmark">Nomin</strong></Link><button type="button" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar"><PanelLeftClose size={17} /></button></div>
      <nav className="capacityNav"><Link href="/"><MessageSquareText size={17} />Workspace</Link><Link className="active" href="/connections"><Plug size={17} />Connections</Link></nav>
    </aside>
    {!sidebarOpen ? <button className="capacitySidebarReveal" type="button" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar"><PanelLeftOpen size={18} /></button> : null}
    <section className="connectionsWorkspace">
      <header className="capacityTop"><div><p>Settings</p><strong>Connections</strong></div><nav><ThemeToggle compact /><AccountMenu /></nav></header>
      <div className="connectionsContent">
        <div className="connectionsIntro"><p>Connect your own API key</p><h1>Choose who runs your requests.</h1><span>The same Nomin workflow, safety rules, planning, tools, and verification stay in place.</span></div>
        <div className="connectionMode"><span>Current mode</span><strong>{safeConnectionLabel(active)}</strong>{active ? <button type="button" onClick={disconnect}><Unplug size={15} />Disconnect</button> : null}</div>
        <form className="connectionForm" onSubmit={validate}>
          <fieldset><legend>1. Choose a provider</legend><div className="providerChoices">{PROVIDERS.map((item) => <button className={provider === item.id ? "selected" : ""} type="button" key={item.id} onClick={() => { setProvider(item.id); setModels([]); setStatus({ kind: "idle", message: "" }); }}><strong>{item.name}</strong><span>{item.description}</span>{provider === item.id ? <Check size={16} /> : null}</button>)}</div></fieldset>
          <fieldset><legend>2. Add connection details</legend><label><span>API key</span><small>Your own provider key. It is kept only in this browser tab, sent to Nomin only while making your requests, and never written to server storage or logs.</small><div className="connectionInput"><KeyRound size={16} /><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Paste your API key" /></div></label>{provider === "compatible" ? <label><span>Base URL</span><small>The local API address supplied by your service. For safety, custom endpoints must be reachable on this computer.</small><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://localhost:1234/v1" /></label> : null}<button className="testConnection" type="submit" disabled={!apiKey || status.kind === "testing"}>{status.kind === "testing" ? "Testing…" : "Test and find models"}</button>{status.message ? <p className={`connectionStatus ${status.kind}`}>{status.message}</p> : null}</fieldset>
          <fieldset><legend>3. Choose how Nomin works</legend>{models.length ? <><label><span>Find a model</span><small>Search the model names returned by your provider.</small><div className="connectionInput"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models" /></div></label><div className="modelResults">{filteredModels.slice(0, 40).map((entry) => <button type="button" className={model === entry ? "selected" : ""} key={entry} onClick={() => setModel(entry)}>{entry}{model === entry ? <Check size={14} /> : null}</button>)}</div></> : null}<label><span>Capable model</span><small>The exact model identifier used for planning, building, and review.</small><input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Model name" /></label><label><span>Fast model <em>optional</em></span><small>A cheaper or quicker model for simple classification. Leave blank to use the capable model everywhere.</small><input value={fastModel} onChange={(event) => setFastModel(event.target.value)} placeholder="Optional fast model" /></label><label><span>Conversation context limit <em>optional</em></span><small>Limits how much conversation history is sent. Lower it for smaller or cheaper models; leave blank for Nomin’s safe default.</small><input type="number" min="2000" max="200000" value={maxContextChars} onChange={(event) => setMaxContextChars(event.target.value)} placeholder="Use safe default" /></label><button className="activateConnection" type="button" onClick={activate}>Use this connection</button></fieldset>
        </form>
      </div>
    </section>
  </main>;
}

export default function ConnectionsPage() {
  return <AccountRouteGuard><ConnectionsPageContent /></AccountRouteGuard>;
}
