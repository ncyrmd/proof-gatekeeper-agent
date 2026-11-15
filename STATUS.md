# Proof Gatekeeper — status (2026-11-15 ~07:45 WIB)

## DONE (verified)
- Agent built from the official protocol spec (own implementation):
  `~/workspace/agent-games/gatekeeper/` — local git repo, HEAD f3b6bcd
  (24 files: src/*, api/agent.ts, circuits/*, test/harness.ts, README, vercel.json).
- Official circuit files downloaded + verified:
  gatekeeper.wasm (1,755,820 bytes, valid WASM), gatekeeper_final.zkey
  (309,750 bytes), verification_key.json extracted (nPublic=13, groth16/bn128).
  Registered vk_hash 0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0.
- Test harness: **26/26 PASS** (`npm test`) — HMAC (hex/base64, tamper/wrong/missing → 401),
  preflight (signed, protocolVersion v1), valid task → APPROVE with proof verified
  locally by snarkjs, all 6 traps → correct REJECT + reason_code with verified proofs,
  PROOF_REUSED (no proof), idempotent redelivery, boundaries, malformed input.
  Valid task ~1.5–2.5 s (deadline 60 s).
- Production build compiles clean (`npm run build`, tsc exit 0); smoke test of the
  built server returns {"ok":true,"protocolVersion":"v1"} on GET /health and /agent.
- Agent-registration API fully mapped (as account #1, SIWE session works):
  addAgentAction id 406c653ffdf23ce1306a90d56bab9777bd095b4999
  args {name, events: ["Proof Gatekeeper"], repoUrl, endpoint}
  -> {ok, name, secret (one-time HMAC plaintext), agentId}
  updateAgentEndpoint id 60034c90cfac0d0a2c276e06558fcc69411ada008e (agentId, endpointUrl)
  updateAgentEvents id 604b59051f0e536777817161d77a22f3988f276191
  updateAgentRepo id 6093da527217b3740348cbdd30541f20fd5850e0aa
  rotateAgentSecret id 401d2a0d4da0b58a3ad2f76340f07faffe712d96f6
  preflightAgent id 4004a8c359b186f7c18dcf3670b6660e389580c550

## BLOCKED (needs the parent / Nicky, in order)
1. **Link GitHub to Agent Games account #1** (HARD BLOCKER for agent registration).
   addAgentAction returns: "Link your GitHub account in Settings before
   registering an agent repository."
   Settings → Connected accounts → GitHub is "Required", status "No [account]",
   Connect button -> /api/auth/github (NextAuth GitHub OAuth).
   Needs a browser session signed in as account #1 (wallet nickyixg7vy75j)
   + GitHub @ncyrmd OAuth approval. Cannot be done programmatically
   (OAuth approval needs the browser + the GitHub session).
2. **Push the repo** to https://github.com/ncyrmd/proof-gatekeeper-agent
   (local repo ready, HEAD f3b6bcd; parent pushes via browser, as with make.fun).
   The repo URL is required at agent creation (must be a public repo on the
   linked personal GitHub account; org repos not supported).
3. **Deploy the endpoint** — no hosting account is connected:
   - Vercel MCP: not_connected (needs Nicky's browser sign-in / OAuth).
   - No Vercel deploy CLI login, no Railway/Fly/Cloudflare account.
   - VM egress proxy blocks all tunnels (localtunnel/cloudflared) — confirmed
     by the Wildcard builder; a tunnel is NOT a viable endpoint.
   Deploy target: Vercel (repo is Vercel-ready: api/agent.ts + vercel.json
   bundles circuits/**). Env var needed at deploy: AGENT_GAMES_HMAC_SECRET
   (obtained at agent creation, step 4).
4. **Create the agent** (script ready: gatekeeper/create-agent.py).
   Once GitHub is linked + the repo is pushed, run it as account #1:
   name "NCYGK-1", events ["Proof Gatekeeper"],
   repoUrl https://github.com/ncyrmd/proof-gatekeeper-agent, endpoint "".
   It saves the HMAC secret to gatekeeper/.env.production (mode 600,
   gitignored) and agent state to gatekeeper/agent-state.json (no secret).
5. **Set the endpoint URL** via updateAgentEndpoint(agentId, "https://<host>/agent")
   — saving runs the platform's signed preflight check. Confirm Healthy.
6. **Practice task** (at least one) before scored rounds. Round 03 runs
   17:30 WIB today (15 Nov) – 03:30 WIB tomorrow; rounds continue daily to 21 Nov.

## Notes
- Kurier API key: NOT configured (optional). Without it the agent still answers
  with the locally generated proof + public_signals (the platform re-verifies
  the proof itself); proof_tx echoes the envelope's reference. A Kurier mainnet
  key would add on-chain submission + a real proof_tx; get one from kurier.xyz
  if wanted (needs an account).
- Seen-set durability: on Vercel the seen-set file lives in /tmp (resets on cold
  start). Within a round, warm instances retain it. A single long-lived instance
  is safer for PROOF_REUSED reliability across the 8 rounds.
- No private keys are stored in this repo or any report. The HMAC secret is
  only ever written to .env.production (mode 600) after agent creation.
