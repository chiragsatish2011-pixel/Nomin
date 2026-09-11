"use client";

import Link from "next/link";
import { Settings2 } from "lucide-react";

export function AccountMenu() {
  return <Link className="accountIcon" href="/connections" title="Connections" aria-label="Connections"><Settings2 size={14} /></Link>;
}
