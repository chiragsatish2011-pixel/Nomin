"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import { LogIn, LogOut, Settings2 } from "lucide-react";
import { useAuth } from "./AuthProvider";

export function AccountMenu() {
  const { configured, loading, user, signOutUser } = useAuth();
  const [failedPhotoUrl, setFailedPhotoUrl] = useState<string | null>(null);
  const photoUrl = user?.photoURL ?? null;
  if (loading) return <span className="accountStatus">Checking account…</span>;
  if (!configured) return <span className="accountStatus">Account setup required</span>;
  if (!user) return <Link className="accountButton primary" href="/login"><LogIn size={14} /> Sign in</Link>;
  const label = user.displayName || user.email || "Account";
  return (
    <div className="accountCluster">
      {photoUrl && failedPhotoUrl !== photoUrl ? (
        <Image
          className="accountAvatar accountAvatarPhoto"
          src={photoUrl}
          alt={`${label}'s profile`}
          width={26}
          height={26}
          unoptimized
          referrerPolicy="no-referrer"
          onError={() => setFailedPhotoUrl(photoUrl)}
        />
      ) : (
        <span className="accountAvatar" aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span>
      )}
      <span className="accountName" title={label}>{label}</span>
      <Link className="accountIcon" href="/connections" title="Connections" aria-label="Connections"><Settings2 size={14} /></Link>
      <button className="accountIcon" type="button" onClick={() => void signOutUser()} title="Sign out" aria-label="Sign out"><LogOut size={14} /></button>
    </div>
  );
}
