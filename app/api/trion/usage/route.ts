// Benchmarking-only readout of a session's real token spend.
//
// Gated behind TRION_BENCH=1 and 404s otherwise. Two reasons it is not a normal
// route: it reports the concrete upstream model id (required to price a call
// against published per-model rates), and the vendor name must never reach a
// user-visible surface. TRION_BENCH is a local measurement flag — never set it
// in a deployed environment.

import { NextResponse } from "next/server";
import { totalsFor, costUsd, getLedger, resetLedger } from "@/lib/agent/token-ledger";

export const runtime = "nodejs";

function enabled() {
  return process.env.TRION_BENCH === "1";
}

export async function GET(request: Request) {
  if (!enabled()) return new NextResponse("Not found", { status: 404 });

  const sessionId = new URL(request.url).searchParams.get("sessionId") ?? "";
  if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });

  const totals = totalsFor(sessionId);
  return NextResponse.json({
    sessionId,
    totals,
    costUsd: costUsd(totals),
    records: getLedger(sessionId)?.records ?? [],
  });
}

export async function DELETE(request: Request) {
  if (!enabled()) return new NextResponse("Not found", { status: 404 });

  const sessionId = new URL(request.url).searchParams.get("sessionId") ?? "";
  if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });

  resetLedger(sessionId);
  return NextResponse.json({ ok: true });
}
