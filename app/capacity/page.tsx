"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Gauge, MessageSquareText, PanelLeftClose, PanelLeftOpen, Plug } from "lucide-react";
import { JellyfishMark } from "@/app/components/JellyfishMark";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { AccountMenu } from "@/app/components/AccountMenu";
import { AccountRouteGuard } from "@/app/components/AccountRouteGuard";

type Capacity = {
  ready: boolean;
  today: string;
  week: string;
  context: string;
  allowance: string;
  requestWindow: { used: number; limit: number; saturation: number };
  activity: { planning: number; building: number };
};

function CapacityPageContent() {
  const [data, setData] = useState<Capacity | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    const saved = window.localStorage.getItem("nomin-sidebar-collapsed");
    return saved !== "1" && !(saved === null && window.innerWidth <= 720);
  });

  const setSidebar = (open: boolean) => {
    setSidebarOpen(open);
    try { localStorage.setItem("nomin-sidebar-collapsed", open ? "0" : "1"); } catch { /* visual state still updates */ }
  };
  const requestAvailability = !data
    ? "Checking"
    : data.requestWindow.saturation >= 1
      ? "At capacity"
      : data.requestWindow.saturation >= 0.75
        ? "Busy"
        : "Available";

  useEffect(() => {
    void fetch("/api/trion/capacity").then((response) => response.ok ? response.json() : null).then(setData).catch(() => setData(null));
  }, []);

  return (
    <main className={`capacityShell${sidebarOpen ? "" : " sidebarClosed"}`}>
      <aside className="capacitySidebar" aria-label="Nomin navigation">
        <div className="capacitySidebarHead">
          <Link className="capacityBrand" href="/"><JellyfishMark size={38} title="Nomin" /><strong className="nominWordmark">Nomin</strong></Link>
          <button type="button" onClick={() => setSidebar(false)} aria-label="Close sidebar" title="Close sidebar"><PanelLeftClose size={17} /></button>
        </div>
        <nav className="capacityNav">
          <Link href="/"><MessageSquareText size={17} /><span>Workspace</span></Link>
          <Link className="active" href="/capacity" aria-current="page"><Gauge size={17} /><span>Capacity</span></Link>
          <Link href="/connections"><Plug size={17} /><span>Connections</span></Link>
        </nav>
      </aside>
      {!sidebarOpen ? <button className="capacitySidebarReveal" type="button" onClick={() => setSidebar(true)} aria-label="Open sidebar" title="Open sidebar"><PanelLeftOpen size={18} /></button> : null}
      <section className="capacityWorkspace">
        <header className="capacityTop">
          <div><p>Workspace health</p><strong>System capacity</strong></div>
          <nav><Link className="capacityBack" href="/">Back to workspace</Link><ThemeToggle compact /><AccountMenu /></nav>
        </header>
        <div className="capacityContent">
          <section className="capacityHero">
            <p>System capacity</p>
            <h1>Your usage and available context.</h1>
            <span>{data?.ready ? "Trion is ready" : "Checking availability"}</span>
          </section>
          <section className="capacityGrid" aria-live="polite">
            <article><p>Today</p><strong>{data?.today ?? "Checking"}</strong><small>Observed Trion activity</small></article>
            <article><p>This week</p><strong>{data?.week ?? "Checking"}</strong><small>Observed Trion activity</small></article>
            <article><p>Context room</p><strong>{data?.context ?? "Checking"}</strong><small>Shown without exposing token counts</small></article>
            <article><p>Request availability</p><strong>{requestAvailability}</strong><small>Live request capacity</small></article>
          </section>
          <section className="capacityNote">
            <p>Allowance</p>
            <strong>{data?.allowance ?? "Loading allowance…"}</strong>
            <span>{data?.activity.building ? "Trion is building and reviewing project changes." : data?.activity.planning ? "Trion is planning your request." : "Trion is ready for a new request."}</span>
          </section>
          <p className="capacityPersistence">Conversation history is cached in this browser and synchronized to your account when signed in. The in-browser project workspace and observed activity counters may reset after the local server or browser workspace restarts.</p>
        </div>
      </section>
    </main>
  );
}

export default function CapacityPage() {
  return <AccountRouteGuard><CapacityPageContent /></AccountRouteGuard>;
}
