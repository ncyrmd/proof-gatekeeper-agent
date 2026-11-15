import { loadConfig } from "../src/config";
import { AgentHandler } from "../src/handler";
import { SeenStore } from "../src/seenStore";
import { SIGNATURE_HEADER } from "../src/types";

/**
 * Vercel serverless entry for POST /agent (and GET health).
 * bodyParser is disabled so the handler sees the RAW body for HMAC
 * verification. A fresh AgentHandler is built per invocation; the seen-set
 * file lives in /tmp on Vercel (best-effort persistence across warm starts).
 */
export const config = {
  api: { bodyParser: false },
};

const cfg = loadConfig();
const handler = new AgentHandler(cfg, new SeenStore(cfg.seenStorePath));

export default function agent(req: any, res: any): void {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks);
    if (req.method === "GET") {
      const r = handler.health();
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.body);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const sig = req.headers[SIGNATURE_HEADER.toLowerCase()] ?? req.headers[SIGNATURE_HEADER];
    const result = await handler.handlePost(raw, Array.isArray(sig) ? sig[0] : sig);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (result.signature) headers[SIGNATURE_HEADER] = result.signature;
    res.writeHead(result.status, headers);
    res.end(result.body);
  });
  req.on("error", () => {
    if (!res.headersSent) res.writeHead(400);
    res.end();
  });
}
