import type { ModelDescriptor, RetryPolicy } from "./registry.js";

/**
 * The doctor team.
 *
 * Six specialists that only run when Nomin itself is broken, and only on the
 * manager's command. They are deliberately *stronger* than the manager: the
 * manager's job is to notice and describe, theirs is to diagnose and repair.
 *
 * Each doctor holds its own credential. That is the whole point of the design —
 * six repairs can run at once without any of them consuming the worker's or the
 * manager's rate budget, and one doctor hitting a limit never stalls the rest.
 */

export type DoctorId = "d1" | "d2" | "d3" | "d4" | "d5" | "d6";

export interface DoctorSpec {
  id: DoctorId;
  /** What this doctor is good at — drives how the manager splits the work. */
  role: string;
  /** One line the user may see. Never mentions models, vendors or code. */
  publicLabel: string;
  backend: string;
  apiKeyEnv: string;
  maxOutputTokens: number;
  temperature: number;
}

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 6,
  baseDelayMs: 2000,
  maxDelayMs: 60000,
  retryStatuses: [408, 409, 425, 429, 500, 502, 503, 504],
};

/**
 * Roles are assigned by what breaks, not by model size alone. The two largest
 * models take diagnosis and the repair itself; the rest verify, hunt for
 * regressions, check the surface, and keep the record straight.
 */
export const DOCTORS: DoctorSpec[] = [
  {
    id: "d1",
    role: "diagnosis",
    publicLabel: "Tracing the fault",
    // The 253B Nemotron is listed by the provider but not servable (404), so
    // diagnosis runs on the 550B Ultra — on its own key, so it never competes
    // with Trion for the worker budget.
    backend: "nvidia/nemotron-3-ultra-550b-a55b",
    apiKeyEnv: "NOMIN_DOCTOR_1_API_KEY",
    maxOutputTokens: 4096,
    temperature: 0.1,
  },
  {
    id: "d2",
    role: "repair",
    publicLabel: "Writing the repair",
    backend: "nvidia/nemotron-3-super-120b-a12b",
    apiKeyEnv: "NOMIN_DOCTOR_2_API_KEY",
    maxOutputTokens: 8192,
    temperature: 0.15,
  },
  {
    id: "d3",
    role: "verification",
    publicLabel: "Checking the repair holds",
    backend: "nvidia/nemotron-3-super-120b-a12b",
    apiKeyEnv: "NOMIN_DOCTOR_3_API_KEY",
    maxOutputTokens: 4096,
    temperature: 0,
  },
  {
    id: "d4",
    role: "regression",
    publicLabel: "Looking for knock-on damage",
    backend: "nvidia/nemotron-3-super-120b-a12b",
    apiKeyEnv: "NOMIN_DOCTOR_4_API_KEY",
    maxOutputTokens: 4096,
    temperature: 0.1,
  },
  {
    id: "d5",
    role: "surface",
    publicLabel: "Checking what the user sees",
    backend: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    apiKeyEnv: "NOMIN_DOCTOR_5_API_KEY",
    maxOutputTokens: 2048,
    temperature: 0,
  },
  {
    id: "d6",
    role: "record",
    publicLabel: "Recording what changed",
    backend: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    apiKeyEnv: "NOMIN_DOCTOR_6_API_KEY",
    maxOutputTokens: 2048,
    temperature: 0,
  },
];

export function doctorModel(spec: DoctorSpec): ModelDescriptor {
  return {
    name: `Doctor ${spec.id.toUpperCase()}`,
    role: "supervisor",
    status: "available",
    backend: spec.backend,
    provider: "nvidia",
    endpoint: process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
    apiKeyEnv: spec.apiKeyEnv,
    contextTokens: 128_000,
    maxOutputTokens: spec.maxOutputTokens,
    capabilities: { tools: false, streaming: true, reasoning: true, vision: spec.id === "d5" },
    retry: DEFAULT_RETRY,
    timeoutMs: 180_000,
    notes: `Repair role: ${spec.role}. Never talks to the user directly.`,
  };
}

/** Which doctors have a usable credential right now. */
export function availableDoctors(env = process.env): DoctorSpec[] {
  return DOCTORS.filter((doctor) => Boolean(env[doctor.apiKeyEnv]));
}
