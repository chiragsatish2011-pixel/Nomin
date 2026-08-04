"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from "firebase/auth";
import { firebaseConfigured, firebaseServices } from "@/app/lib/firebase-client";

type AuthContextValue = {
  configured: boolean;
  loading: boolean;
  user: User | null;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  createAccount: (email: string, password: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  signOutUser: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(firebaseConfigured);

  useEffect(() => {
    const services = firebaseServices();
    if (!services) {
      return;
    }
    return onAuthStateChanged(services.auth, (next) => {
      setUser(next);
      setLoading(false);
    });
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    configured: firebaseConfigured,
    loading,
    user,
    async signInWithGoogle() {
      const services = firebaseServices();
      if (!services) throw new Error("Sign-in has not been configured for this installation.");
      const provider = new GoogleAuthProvider();
      try {
        await signInWithPopup(services.auth, provider);
      } catch (error) {
        // Popup-only login fails in browsers with a strict popup policy (and in
        // embedded webviews). Redirect is Firebase's supported first-party
        // fallback and returns through the normal auth-state listener.
        const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
        if (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment") {
          await signInWithRedirect(services.auth, provider);
          return;
        }
        throw error;
      }
    },
    async signInWithEmail(email, password) {
      const services = firebaseServices();
      if (!services) throw new Error("Sign-in has not been configured for this installation.");
      await signInWithEmailAndPassword(services.auth, email, password);
    },
    async createAccount(email, password) {
      const services = firebaseServices();
      if (!services) throw new Error("Sign-in has not been configured for this installation.");
      await createUserWithEmailAndPassword(services.auth, email, password);
    },
    async resetPassword(email) {
      const services = firebaseServices();
      if (!services) throw new Error("Sign-in has not been configured for this installation.");
      await sendPasswordResetEmail(services.auth, email);
    },
    async signOutUser() {
      const services = firebaseServices();
      if (services) await signOut(services.auth);
    },
  }), [loading, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider.");
  return value;
}
