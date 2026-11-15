# Proof Gatekeeper Agent — zkVerify Agent Games

An HTTPS agent endpoint for the **Proof Gatekeeper** event in the zkVerify
Agent Games (account `nickyixg7vy75j`, wallet `0xFb86D38e06C68CFC7e64eA0adb52C6F4E5040d24`).
The platform POSTs signed task envelopes; this service verifies the HMAC,
makes a deterministic APPROVE/REJECT decision, generates a real Groth16 proof
locally with snarkjs against the official gatekeeper circuit, optionally
submits it to zkVerify via Kurier, and returns a signed response — well inside
the 60-second hard deadline (typical end-to-end: ~1.5–2.5 s).

## Deployment (as registered)

Production endpoint: `https://<host>/agent` (see "Registration & preflight flow"
below for how the URL is registered).

The circuit artifacts `circuits/gatekeeper.wasm` and
`circuits/gatekeeper_final.zkey` are the official files published on the
Agent Games build page (https://agentgames.zkverify.io/build, see also
`/api/circuit-info`); they are binary platform artifacts. The verification key
extracted from the proving key (`circuits/verification_key.json`) IS included,
for local proof verification in the test harness.

## Architecture

```
POST /agent
  │
  ├─ 1. HMAC-SHA256 over the RAW body vs `x-agent-games-signature`
  │     (verified BEFORE JSON parsing; mismatch → HTTP 401)
  ├─ 2. type = "agent-games.preflight.v1"
  │     → signed `{ ok: true, protocolVersion: "v1" }`
  └─ 3. type = "agent-games.proof-gatekeeper.v1"
        ├─ idempotency cache (same task_id → cached response)
        ├─ deadline/timestamp sanity → fail closed
        ├─ deterministic policy (src/decision.ts) → decision + reason_code
        ├─ snarkjs fullProve with gatekeeper.wasm / gatekeeper_final.zkey
        │    (skipped only for PROOF_REUSED — documented as having no proof)
        ├─ Kurier submit + bounded poll (≤15 s) → on-chain txHash as proof_tx
        └─ signed JSON response
```

Fail-closed throughout: malformed envelopes, internal errors, and proof
generation failures all resolve to REJECT, never to an unproven APPROVE.

### File layout

| Path | Purpose |
| --- | --- |
| `api/agent.ts` | Vercel serverless entry (`bodyParser: false` → raw body for HMAC). |
| `src/server.ts` | Vercel backends entrypoint (default-exports the HTTP server). |
| `src/local-server.ts` | Plain Node HTTP server (`npm start` / `npm run dev`). |
| `src/handler.ts` | Framework-agnostic request pipeline shared by both entries. |
| `src/hmac.ts` | HMAC sign/verify + per-task circuit salt derivation. |
| `src/decision.ts` | Deterministic policy + envelope→circuit field conversion. |
| `src/prover.ts` | snarkjs `groth16.fullProve` wrapper (+ local verify). |
| `src/kurier.ts` | Kurier submit-proof + job-status polling (never throws). |
| `src/seenStore.ts` | proof_tx seen-set + response cache, JSON-file backed. |
| `circuits/` | `gatekeeper.wasm`, `gatekeeper_final.zkey`, `verification_key.json` (extracted from the zkey). |
| `test/harness.ts` | Local end-to-end harness (`npm test`). |

## Protocol details (from the /build spec)

**Task envelope** (`POST /agent`):

```
{
  "type": "agent-games.proof-gatekeeper.v1",
  "task_id": "gk_...",
  "mode": "competition",
  "issued_at": "<issued-at>",
  "deadline_at": "<deadline-at>",
  "input": {
    "registered_vk": "0x…", "proof_vk": "0x…",
    "minimum": "1000", "public_balance": "1460",
    "expiry_block": 8430000, "current_block": 8420000,
    "recipient": "0x…", "condition_recipient": "0x…",
    "amount": "500", "max_transfer": "1000",
    "proof_tx": "0x…"
  }
}
```

**Response** (all fields the spec mentions, so either verification path finds
what it needs):

```
{
  "decision": "APPROVE" | "REJECT",
  "reason_code": "VALID_CONDITION" | "VK_SUBSTITUTION" | "PROOF_REUSED"
               | "THRESHOLD_MISMATCH" | "EXPIRED_CONDITION"
               | "RECIPIENT_MISMATCH" | "AMOUNT_OVERFLOW",
  "proof": { "pi_a": […], "pi_b": […], "pi_c": […], "protocol": "groth16", "curve": "bn128" },
  "public_signals": ["<13 field elements>"],
  "proof_tx": "0x…"
}
```

plus the `x-agent-games-signature` header (HMAC over the raw response body).

For `PROOF_REUSED` the response carries no proof — the event page states
those tasks "have no proof to submit and are excluded" from proof scoring.

**Decision rules** (mirroring the circuit exactly, boundaries included):
APPROVE only if `proof_vk == registered_vk`, `proof_tx` unseen,
`public_balance >= minimum`, `current_block < expiry_block`,
`recipient == condition_recipient`, and `amount <= max_transfer`.

**Scoring** (per /events/proof-gatekeeper): correct APPROVE +12, correct REJECT
+12, incorrect APPROVE −6, incorrect REJECT −3, timeout −2, missing/invalid
proof −2, reliability bonus +0..+5 (pro-rated by the share of provable tasks
whose proof verified). 8 daily rounds, 13–21 Nov 2026, 8 tasks per agent per
round; scores are cumulative.

## The circuit

Input signal names are not published; they were recovered from the official
`gatekeeper.wasm` artifact and confirmed by proving. The circuit
(`GatekeeperEvaluation`) takes 13 inputs:

```
taskId, registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
currentBlock, recipient, conditionRecipient, amount, maxTransfer,
decision, salt (private)
```

and emits 13 public signals: `[Poseidon(taskId, salt), …the 12 public inputs in the order above…]`. Critically, the circuit **asserts `decision == (all five
field checks)`**: witness generation fails for `decision=1` on a trapped statement and for `decision=0` on a valid one — the
circuit is the referee, exactly as the /build page describes. Field elements
are the envelope values reduced mod the BN128 prime (a 32-byte hash does not
fit the field; reduction preserves the equality checks the circuit performs). `salt` is derived deterministically as `HMAC(secret, "gatekeeper-salt:" + task_id)
 mod p`, so a redelivered task reproduces identical proof inputs.

Registered gatekeeper vk_hash on zkVerify mainnet (from `/api/circuit-info`):
`0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`.

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `AGENT_GAMES_HMAC_SECRET` | yes | Platform-generated; dashboard → agent → **Rotate Secret**, copy the one-time plaintext. Never a local placeholder. |
| `KURIER_API_KEY` | no | Mainnet Kurier key. If unset, submission is skipped gracefully and the agent still answers with proof + public_signals. |
| `KURIER_API_URL` | no | Default `https://api.kurier.xyz/api/v1` (mainnet). |
| `GATEKEEPER_VK_HASH` | no | Defaults to the registered gatekeeper vk_hash `0x6b79c6…77b0`. |
| `KURIER_POLL_BUDGET_MS` | no | Default 15000. |
| `TASK_SOFT_DEADLINE_MS` | no | Default 50000 (hard platform deadline is 60 s). |
| `SEEN_STORE_PATH` | no | Default `data/seen.json` locally, `/tmp/…` on Vercel. |
| `CIRCUITS_DIR`, `PORT` | no | Artifact location override; local port (default 8787). |

No secrets are hardcoded anywhere; `.env` is gitignored and `.env.example` ships blank values.

## Registration & preflight flow

1. Deploy (Vercel: `vercel deploy`, the function bundles `circuits/**` via
   `vercel.json`; or run `npm run build && npm start` on any Node ≥18 host).
2. Register the full handler path — `https://<host>/agent`, not the root —
   in the Agent Games dashboard.
3. Dashboard → **Rotate Secret** → set the revealed plaintext as
   `AGENT_GAMES_HMAC_SECRET` → redeploy/restart.
4. The platform sends a signed preflight (`type: agent-games.preflight.v1`);
   this agent answers `{ ok: true, protocolVersion: "v1" }` signed, and the
   dashboard marks the agent active. `GET /agent` also serves as the health
   check.
5. Complete at least one practice task before scored rounds.

## Local test results

`npm test` boots the real server and replays spec-shaped envelopes — **26/26 checks pass**, including:
- HMAC roundtrip (hex + base64 acceptance), tamper/wrong-secret/missing → reject
- Preflight body shape + valid response signature; bad HMAC → 401
- Valid task → APPROVE / VALID_CONDITION, proof **verified locally** with
  `snarkjs groth16 verify` against the extracted verification key
- All six traps → correct REJECT + reason_code, each proof verified
  (PROOF_REUSED correctly carries no proof)
- Idempotent redelivery (cached response, not misread as reuse)
- Boundary conditions (balance == minimum, amount == max_transfer,
  current_block == expiry_block − 1 → APPROVE)
- Response times: ~1.5–2.5 s per task — far under the 60 s deadline even with
  the 15 s Kurier budget on top

## Deployment notes

- **Seen-set durability:** the seen-set lives in process memory + a JSON
  file. On Vercel the file is in `/tmp` and state can reset on cold start;
  within a round, warm instances retain it. For maximum PROOF_REUSED
  reliability across the 8 rounds, a single long-lived instance
  (`npm start` on a small VM/container) is the safer host.
- **Kurier costs/credits** are the operator's: every provable task submits
  one proof to zkVerify mainnet when a key is configured. Without a key the
  agent still answers with the locally generated proof + public_signals
  (the platform re-verifies the proof itself); the on-chain submission is
  then skipped and `proof_tx` echoes the envelope's reference.

## Spec ambiguities handled defensively

- **HMAC encoding:** /build mandates HMAC over the raw body but never states
  the exact key encoding. Outbound signing is HMAC-SHA256 hex; inbound
  verification accepts hex or base64 of the same MAC bytes (and an optional
  `sha256=` prefix), compared in constant time.
- **"Finalized before approval"** (Security checklist): the envelope carries
  no independently checkable finality proof for the referenced on-chain
  proof, so this is implemented as: our own proof is submitted to Kurier and
  its on-chain `txHash` is returned as `proof_tx` as soon as the submission
  transaction exists (the Submitted status); finalization itself completes
  server-side at Kurier without blocking the response.
- **`INVALID_TASK`** is a local fallback reason code for envelope-level
  failures (malformed input, past deadline, internal error). It is outside
  the documented 7-code taxonomy and only reachable off the scored paths.
- **`task_id` → field element:** free-form ids (e.g. `gk_8d31_…`) are hashed
  (SHA-256, mod p) into the circuit's `taskId` input; numeric/hex ids are
  used directly.
