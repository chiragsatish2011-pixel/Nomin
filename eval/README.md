# Nomin/Trion Production Evaluation Framework

**3 Levels × 3 Depths + Security Evaluation** — runnable end-to-end with real model calls through the existing single-key provider lane.

## Prerequisites

```bash
# 1. Node.js 20+ installed
# 2. Provider credentials configured in the running app. The runtime health
#    endpoint reports the redacted active-key count; it never exposes secrets.
# 3. From the web app directory (where package.json lives):
cd "<repo-checkout>/Trion 1.4/web"
npm ci
```

## Key-Pool Verification (RUN FIRST)

```bash
# Reads the running app's redacted pool snapshot. It does not read or print keys.
node eval/scripts/verify-keys.mjs
```

**Expected output:** active key count and one shared RPM budget. Multiple keys
improve failover; they do not multiply a free-tier allowance.

## Full Evaluation Sequence (RUN IN ORDER)

### Terminal 1 — Start Server (keep running for all live-call levels)

```bash
cd "<repo-checkout>/Trion 1.4/web"
TRION_BENCH=1 TRION_PERF=1 npm run dev
```

> **Note:** `TRION_BENCH=1` enables `/api/trion/usage` (provider-reported token spend). `TRION_PERF=1` enables timing breakdown. Both required for evaluation.

### Terminal 2 — Run Levels (each writes JSON to `eval/results/`)

```bash
# SAFE DEFAULT — local, no provider calls
node eval/scripts/run-all.mjs --tag local-check

# LIVE SUITES — only with an active browser bridge and an intentional RPM budget.
# The online load test is excluded unless explicitly requested.
# LEVEL 1 — Unit (existing 13-case speed + 11-case coding suites)
# Runs against live server, measures token/latency per case
# Duration: ~3-5 minutes
node eval/unit/run.mjs --tag baseline

# LEVEL 2 — LLM-as-Judge (calibration REQUIRED before grading)
# First, calibrate the judge (must pass 5/5 known-answer cases)
node eval/judge/run.mjs --tag baseline --calibrate-only

# If calibration passes, run full judge grading (would grade unit outputs)
node eval/judge/run.mjs --tag baseline

# LEVEL 3 — Online/Production-Condition (concurrent load via key pool)
# 5 concurrent sessions × 3 turns each, mixed speed/coding workload
# Duration: ~5-10 minutes
node eval/online/runner.mjs --tag baseline --concurrent=5 --turns=3

# SECURITY — 5 Attack Vectors (runs independently, no server needed for most)
# Tests: Critic tool restriction, data exfiltration, prompt injection, system prompt leakage, privilege escalation
# Duration: ~1-2 minutes
node eval/security/run.mjs --tag baseline

# TRAJECTORY — Tool Trace / Decision Path Analysis
# 8 assertions on coding suite cases (premature finish, tool accuracy, coherence, action contract, etc.)
# Duration: ~5-10 minutes
node eval/trajectory/run.mjs --tag baseline --cases=T1,T2,T3,T4,T5,T6,T7,T8,T9,T10,T11

# COMPONENT — Isolated Component Tests (no server needed)
# Classifier (24 cases), heuristics, rate governor, rate governor (4 tests), critics (3 tests)
# Duration: ~30 seconds
node eval/component/run.mjs --tag baseline
```

### Compare Results (after making changes)

```bash
# 1. Make your changes
# 2. Restart server with TRION_BENCH=1 TRION_PERF=1
# 3. Re-run evaluation with new tag
node eval/scripts/run-all.mjs --tag my-changes --live

# 4. Compare baseline vs changes
node eval/scripts/compare.mjs baseline my-changes
```

## Output Artifacts

All commands write timestamped JSON to `eval/results/`:

| File | Level | Contains |
|------|-------|----------|
| `unit-<tag>-<ts>.json` | Unit | Pass/fail + token/latency per case (13 speed + 11 coding) |
| `judge-<tag>-<ts>.json` | Judge | Rubric scores + calibration evidence |
| `online-<tag>-<ts>.json` | Online | Concurrent load metrics + success rates by mode |
| `security-<tag>-<ts>.json` | Security | 5-vector pass/fail with reproduction steps |
| `trajectory-<tag>-<ts>.json` | Trajectory | 8 assertions × 11 cases = 88 checks |
| `component-<tag>-<ts>.json` | Component | Classifier, heuristics, rate governor, critics |

## Evaluation Framework Structure

```
eval/
├── README.md                    # This file
├── scripts/
│   ├── verify-keys.mjs         # Key-pool wiring check
│   ├── run-all.mjs             # Master runner (all levels in sequence)
│   └── compare.mjs             # Before/after comparison tables
├── unit/
│   └── run.mjs                 # 13-case speed + 11-case coding (live server)
├── judge/
│   ├── rubrics.mjs             # Structured rubrics (coding, design, classification)
│   └── run.mjs                 # Calibration harness + judge runner
├── security/
│   ├── probes.mjs              # 5 attack vectors as executable test cases
│   └── run.mjs                 # Security runner with critical finding flagging
├── trajectory/
│   ├── assertions.mjs          # 8 trajectory assertions on tool_trace
│   └── run.mjs                 # Trajectory runner
├── component/
│   ├── tests.mjs               # Isolated classifier, rate governor, critic tests
│   └── run.mjs                 # Component runner
├── online/
│   └── runner.mjs              # Concurrent load simulation
└── results/                    # Timestamped JSON outputs (gitignored)
```

## Constraints Enforced

- ✅ All live calls route through existing single-key provider lane (no bypass)
- ✅ No fabricated results — tests fail loudly if server/model unavailable
- ✅ No Nemotron/NIM strings in any output (sanitized by gateway)
- ✅ Background-process priority: eval yields to real traffic via the single-key lane
- ✅ Calibration required before LLM-as-Judge grading
- ✅ Security critical findings flagged at top of report

## Expected Runtime (full suite)

| Level | Approximate Time |
|-------|------------------|
| Unit | 3-5 min |
| Judge (calibration) | 30 sec |
| Online | 5-10 min |
| Security | 1-2 min |
| Trajectory | 5-10 min |
| Component | 30 sec |
| **Total** | **~20-30 min** |

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `usage endpoint returned 404` | Ensure `TRION_BENCH=1` on server |
| `WebContainer bridge unavailable` | Server must be running; check port 3000 |
| `Calibration failed` | Fix rubric criteria in `eval/judge/rubrics.mjs` |
| `Key pool shows 0 keys` | Check `.env.local` has `TRION_API_KEY_1` through `TRION_API_KEY_5` |
| `Concurrent sessions hang` | Key pool RPM limit reached; reduce `--concurrent` |

## Key status

Never place real API keys in this document or any committed source file.
The runtime reads `TRION_API_KEY_1` through `TRION_API_KEY_5` from the local
environment, and `MAX_PROVIDER_KEYS = 5` allows all five configured slots to
participate. Use `node eval/scripts/verify-keys.mjs` to check redacted counts.
