"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Check, LoaderCircle } from "lucide-react";
import { JellyfishMark } from "@/app/components/JellyfishMark";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { useAuth } from "@/app/components/AuthProvider";

function friendly(error: unknown) {
  const message = error instanceof Error ? error.message : "Sign-in did not complete.";
  if (/invalid-credential|wrong-password|user-not-found/i.test(message)) return "That email or password was not accepted.";
  if (/email-already-in-use/i.test(message)) return "An account already exists for that email.";
  if (/weak-password/i.test(message)) return "Use a password with at least six characters.";
  if (/popup-closed/i.test(message)) return "The sign-in window was closed before it finished.";
  if (/unauthorized-domain/i.test(message)) return "This site address is not authorised for Google sign-in yet. Add it in Firebase Authentication, then try again.";
  if (/operation-not-allowed/i.test(message)) return "Google sign-in is not enabled for this Firebase project yet.";
  return message.replace(/^Firebase:\s*/i, "");
}

function LoginPageContent() {
  const auth = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next");
  const returnTo = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => { if (!auth.loading && auth.user) router.replace(returnTo); }, [auth.loading, auth.user, returnTo, router]);

  async function submit() {
    setWorking(true); setError(""); setNotice("");
    try {
      if (creating) await auth.createAccount(email.trim(), password);
      else await auth.signInWithEmail(email.trim(), password);
      router.replace(returnTo);
    } catch (reason) { setError(friendly(reason)); }
    finally { setWorking(false); }
  }

  async function google() {
    setWorking(true); setError("");
    try { await auth.signInWithGoogle(); router.replace(returnTo); }
    catch (reason) { setError(friendly(reason)); }
    finally { setWorking(false); }
  }

  async function reset() {
    if (!email.trim()) { setError("Enter your email first, then choose reset password."); return; }
    try { await auth.resetPassword(email.trim()); setNotice("Password reset email sent."); setError(""); }
    catch (reason) { setError(friendly(reason)); }
  }

  return <main className="authPage">
    <header className="authTop"><Link href="/" className="authBrand"><JellyfishMark size={36} title="Nomin" /><span className="nominWordmark">Nomin</span></Link><ThemeToggle /></header>
    <section className="authLayout">
      <aside className="authStory"><span className="authEyebrow">Your workspace, wherever you return</span><h1>Continue the work, not the setup.</h1><p>Your conversations and visible checkpoints follow your account. Sign in once; this browser remembers you.</p><ul><li><Check size={15}/> Synced conversation history</li><li><Check size={15}/> Private account workspace</li><li><Check size={15}/> Local-first resilience</li></ul><JellyfishMark className="authJelly" size={150} motion="full" /></aside>
      <section className="authPanel" aria-labelledby="auth-heading">
        <div><p className="authEyebrow">{creating ? "Create your account" : "Welcome back"}</p><h2 id="auth-heading">{creating ? "Start with Nomin" : "Sign in to Nomin"}</h2><p>{creating ? "One account keeps your work together." : "Pick up from any saved conversation."}</p></div>
        {!auth.configured ? <div className="authConfigNote">Sign-in is not configured for this installation yet. Add the Firebase web values from <code>.env.example</code>, then restart Nomin.</div> : null}
        <button className="googleButton" type="button" disabled={!auth.configured || working} onClick={() => void google()}><span className="googleGlyph">G</span> Continue with Google</button>
        <div className="authDivider"><span>or use email</span></div>
        <label className="authField"><span>Email address</span><input autoComplete="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></label>
        <label className="authField"><span>Password</span><input autoComplete={creating ? "new-password" : "current-password"} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" /></label>
        {error ? <p className="authError" role="alert">{error}</p> : null}{notice ? <p className="authNotice">{notice}</p> : null}
        <button className="authSubmit" type="button" disabled={!auth.configured || working || !email.trim() || !password} onClick={() => void submit()}>{working ? <LoaderCircle className="spin" size={16}/> : null}{creating ? "Create account" : "Continue"}<ArrowRight size={16}/></button>
        {!creating ? <button className="authTextButton" type="button" onClick={() => void reset()}>Reset password</button> : null}
        <p className="authSwitch">{creating ? "Already have an account?" : "New to Nomin?"} <button type="button" onClick={() => { setCreating(!creating); setError(""); }}>{creating ? "Sign in" : "Create one"}</button></p>
      </section>
    </section>
  </main>;
}

export default function LoginPage() {
  return <Suspense fallback={<main className="routeGate"><JellyfishMark size={42} motion="minimal" /><span>Opening sign-in…</span></main>}><LoginPageContent /></Suspense>;
}
