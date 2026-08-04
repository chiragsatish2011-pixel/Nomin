"use client";

import { collection, deleteDoc, doc, getDocs, setDoc } from "firebase/firestore";
import { firebaseServices } from "./firebase-client";

export type CloudSessionRecord = {
  id: string;
  title: string;
  updatedAt: number;
  checkpoint: unknown;
};

function owner() {
  const services = firebaseServices();
  const uid = services?.auth.currentUser?.uid;
  return services && uid ? { ...services, uid } : null;
}

export async function saveCloudSession(record: CloudSessionRecord) {
  const current = owner();
  if (!current) return;
  await setDoc(doc(current.db, "users", current.uid, "sessions", record.id), record, { merge: true });
}

export async function deleteCloudSession(id: string) {
  const current = owner();
  if (!current) return;
  await deleteDoc(doc(current.db, "users", current.uid, "sessions", id));
}

export async function loadCloudSessions(): Promise<CloudSessionRecord[]> {
  const current = owner();
  if (!current) return [];
  const result = await getDocs(collection(current.db, "users", current.uid, "sessions"));
  return result.docs
    .map((entry) => entry.data() as CloudSessionRecord)
    .filter((entry) => entry && typeof entry.id === "string")
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
