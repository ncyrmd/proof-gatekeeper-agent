import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as snarkjs from "snarkjs";
import { createAgentServer } from "../src/local-server";
import { signBody } from "../src/hmac";

/**
 * Local end-to-end harness: boots the real server and replays spec-shaped
 * envelopes. Run with `npm test` (needs circuits/ + a test HMAC secret).
 *
 * Checks:
 *  - HMAC roundtrip (hex + base64 acceptance), tamper/wrong-secret/missing -> 401
 *  - Preflight body shape + valid response signature; bad HMAC -> 401
 *  - Valid task -> APPROVE / VALID_CONDITION, proof verified locally with
 *    snarkjs groth16 verify against the extracted verification key
 *  - All six traps -> correct REJECT + reason_code, each proof verified
 *    (PROOF_REUSED correctly carries no proof)
 *  - Idempotent redelivery (cached response, not misread as reuse)
 *  - Response times well under the 60 s deadline
 */

const TEST_SECRET = "test-harness-secret-do-not-use-in-production";
const VK_PATH = path.resolve(__dirname, "..", "circuits", "verification_key.json");
const PORT = 18787;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function baseInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    registered_vk: "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0",
    proof_vk: "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0",
    minimum: "1000",
    public_balance: "1460",
    expiry_block: 8430000,
    current_block: 8420000,
    recipient: "0xDe42a1b2c3d4e5f60718293a4b5c6d7e8f90123",
    condition_recipient: "0xDe42a1b2c3d4e5f60718293a4b5c6d7e8f90123",
    amount: "500",
    max_transfer: "1000",
    // NOTE: proof_tx is filled per-task by taskEnvelope/runTask below so each
    // test case gets a UNIQUE reference (otherwise the seen-set correctly
    // flags later cases as PROOF_REUSED).
    proof_tx: "0x0000000000000000000000000000000000000000000000000000000000000000",
    ...over,
  };
}

function taskEnvelope(taskId: string, input: Record<string, unknown>, proofTxOverride?: string): Record<string, unknown> {
  const now = new Date();
  // Unique proof_tx per task_id (derived deterministically from the task id),
  // unless the caller explicitly overrides it (PROOF_REUSED test).
  const txDigest = crypto.createHash("sha256").update(`proof-tx:${taskId}`).digest("hex");
  const uniqueInput = { ...input, proof_tx: proofTxOverride ?? `0x${txDigest}` };
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: taskId,
    mode: "practice",
    issued_at: now.toISOString(),
    deadline_at: new Date(now.getTime() + 60_000).toISOString(),
    input: uniqueInput,
  };
}

async function post(
  body: string,
  secret: string | null,
  encoding: "hex" | "base64" | "none" = "hex",
): Promise<{ status: number; body: string; sig: string | null }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null && encoding !== "none") {
    const mac = crypto.createHmac("sha256", secret).update(body).digest();
    headers["x-agent-games-signature"] = encoding === "hex" ? mac.toString("hex") : mac.toString("base64");
  }
  const res = await fetch(`http://127.0.0.1:${PORT}/agent`, { method: "POST", headers, body });
  const text = await res.text();
  return { status: res.status, body: text, sig: res.headers.get("x-agent-games-signature") };
}

async function main(): Promise<void> {
  console.log("[harness] extracting verification key (if needed)...");
  if (!fs.existsSync(VK_PATH)) {
    const vk = await snarkjs.zKey.exportVerificationKey(
      path.resolve(__dirname, "..", "circuits", "gatekeeper_final.zkey"),
    );
    fs.writeFileSync(VK_PATH, JSON.stringify(vk, null, 1));
  }
  const vk = JSON.parse(fs.readFileSync(VK_PATH, "utf8")) as Record<string, unknown>;
  console.log(`[harness] verification key loaded (nPublic=${(vk as { nPublic?: number }).nPublic})`);

  process.env.AGENT_GAMES_HMAC_SECRET = TEST_SECRET;
  process.env.SEEN_STORE_PATH = path.resolve(__dirname, "..", "data", "harness-seen.json");
  try { fs.unlinkSync(process.env.SEEN_STORE_PATH); } catch { /* fresh */ }
  const server = createAgentServer();
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  console.log(`[harness] server up on :${PORT}`);

  try {
    // ---- HMAC ----
    console.log("\n== HMAC ==");
    const goodBody = JSON.stringify({ type: "agent-games.preflight.v1" });
    const r1 = await post(goodBody, TEST_SECRET, "hex");
    check("preflight with hex HMAC -> 200 + ok", r1.status === 200 && JSON.parse(r1.body).ok === true, `status=${r1.status} body=${r1.body}`);
    const r1b = await post(goodBody, TEST_SECRET, "base64");
    check("preflight with base64 HMAC -> 200", r1b.status === 200, `status=${r1b.status}`);
    const r2 = await post(goodBody, "wrong-secret", "hex");
    check("wrong secret -> 401", r2.status === 401, `status=${r2.status}`);
    const r3 = await post(goodBody, null, "none");
    check("missing signature -> 401", r3.status === 401, `status=${r3.status}`);
    const tampered = JSON.stringify({ type: "agent-games.preflight.v1", extra: 1 });
    const r4 = await post(tampered, TEST_SECRET, "hex");
    // sign the ORIGINAL body, send a DIFFERENT one -> must 401
    const r4b = await (async () => {
      const mac = crypto.createHmac("sha256", TEST_SECRET).update(goodBody).digest("hex");
      const res = await fetch(`http://127.0.0.1:${PORT}/agent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agent-games-signature": mac },
        body: tampered,
      });
      return { status: res.status, body: await res.text() };
    })();
    void r4;
    check("tampered body (sig over other body) -> 401", r4b.status === 401, `status=${r4b.status}`);

    // ---- Preflight response signature ----
    console.log("\n== Preflight ==");
    check("preflight response is signed (verifies)", (() => {
      if (!r1.sig) return false;
      return signBody(TEST_SECRET, r1.body) === r1.sig;
    })(), `sig=${r1.sig}`);
    const pre = JSON.parse(r1.body) as { protocolVersion?: string };
    check("preflight protocolVersion v1", pre.protocolVersion === "v1");

    // ---- Valid task + traps ----
    console.log("\n== Tasks ==");
    async function runTask(taskId: string, input: Record<string, unknown>, proofTxOverride?: string) {
      const env = JSON.stringify(taskEnvelope(taskId, input, proofTxOverride));
      const t0 = Date.now();
      const r = await post(env, TEST_SECRET, "hex");
      const ms = Date.now() - t0;
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(r.body) as Record<string, unknown>; } catch { /* */ }
      return { r, parsed, ms };
    }
    async function verifyProof(parsed: Record<string, unknown> | null): Promise<boolean> {
      if (!parsed || typeof parsed.proof !== "object" || !parsed.public_signals) return false;
      try {
        return await snarkjs.groth16.verify(vk, parsed.public_signals as string[], parsed.proof as never);
      } catch {
        return false;
      }
    }

    // Valid
    const v = await runTask("gk_harness_valid_1", baseInput());
    check("valid task -> APPROVE/VALID_CONDITION", v.parsed?.decision === "APPROVE" && v.parsed?.reason_code === "VALID_CONDITION", JSON.stringify(v.parsed));
    check("valid task proof verifies locally", await verifyProof(v.parsed));
    check("valid task response signed", !!v.r.sig && signBody(TEST_SECRET, v.r.body) === v.r.sig);
    check("valid task < 60s", v.ms < 60_000, `${v.ms}ms`);
    console.log(`  (valid task took ${v.ms}ms)`);

    // Traps
    const traps: Array<{ name: string; input: Record<string, unknown>; code: string }> = [
      { name: "VK_SUBSTITUTION", input: baseInput({ proof_vk: "0xa4c1b8ff0000000000000000000000000000000000000000000000000000000002" }), code: "VK_SUBSTITUTION" },
      { name: "THRESHOLD_MISMATCH", input: baseInput({ public_balance: "999" }), code: "THRESHOLD_MISMATCH" },
      { name: "EXPIRED_CONDITION", input: baseInput({ current_block: 8430000 }), code: "EXPIRED_CONDITION" },
      { name: "RECIPIENT_MISMATCH", input: baseInput({ recipient: "0x1111111111111111111111111111111111111111" }), code: "RECIPIENT_MISMATCH" },
      { name: "AMOUNT_OVERFLOW", input: baseInput({ amount: "1001" }), code: "AMOUNT_OVERFLOW" },
    ];
    for (const t of traps) {
      const res = await runTask(`gk_harness_${t.name.toLowerCase()}_1`, t.input);
      check(`${t.name} -> REJECT/${t.code}`, res.parsed?.decision === "REJECT" && res.parsed?.reason_code === t.code, JSON.stringify(res.parsed));
      check(`${t.name} proof verifies locally`, await verifyProof(res.parsed));
    }

    // PROOF_REUSED: re-send the valid task's proof_tx with a new task_id
    const validTx = `0x${crypto.createHash("sha256").update("proof-tx:gk_harness_valid_1").digest("hex")}`;
    const reused = await runTask("gk_harness_reused_1", baseInput(), validTx);
    check("PROOF_REUSED -> REJECT/PROOF_REUSED", reused.parsed?.decision === "REJECT" && reused.parsed?.reason_code === "PROOF_REUSED", JSON.stringify(reused.parsed));
    check("PROOF_REUSED carries no proof", !("proof" in (reused.parsed ?? {})));

    // Idempotent redelivery: same task_id as the valid task -> cached identical response
    const redeliver = await runTask("gk_harness_valid_1", baseInput());
    check("redelivery returns cached identical response", redeliver.r.body === v.r.body, `len ${redeliver.r.body.length} vs ${v.r.body.length}`);

    // Boundary checks: balance == minimum passes, amount == max passes, current == expiry-1 passes
    const boundary = await runTask("gk_harness_boundary_1", baseInput({ public_balance: "1000", amount: "1000", current_block: 8429999 }));
    check("boundary (balance==min, amount==max, current==expiry-1) -> APPROVE", boundary.parsed?.decision === "APPROVE", JSON.stringify(boundary.parsed));

    // Malformed envelope -> REJECT/INVALID_TASK (still signed, still 200)
    const bad = await post(JSON.stringify({ type: "agent-games.proof-gatekeeper.v1", task_id: "gk_bad", input: { minimum: "x" } }), TEST_SECRET, "hex");
    check("malformed input -> REJECT/INVALID_TASK", bad.status === 200 && JSON.parse(bad.body).reason_code === "INVALID_TASK", bad.body);
  } finally {
    server.close();
  }

  console.log(`\n[harness] ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`[harness] failures: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[harness] fatal:", err);
  process.exit(1);
});
