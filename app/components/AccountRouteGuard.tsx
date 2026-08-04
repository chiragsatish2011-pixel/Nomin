"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { JellyfishMark } from "@/app/components/JellyfishMark";
import { useAuth } from "@/app/components/AuthProvider";

/** Keeps private account surfaces out of an anonymous browser. */
export function AccountRouteGuard({ children }: { children: ReactNode }) {
  const { loading, user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(pathname || "/")}`);
  }, [loading, pathname, router, user]);

  if (loading || !user) {
    return <main className="routeGate" aria-live="polite"><JellyfishMark size={42} motion="minimal" /><span>Opening your account workspace…</span></main>;
  }
  return <>{children}</>;
}
