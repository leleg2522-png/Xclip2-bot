import { Router, type IRouter } from "express";
import { insertRefreshToken } from "../lib/invite-runner.js";

const router: IRouter = Router();

router.post("/local-token", async (req, res) => {
  // Accepted upload secrets, in order of preference:
  //  1. LOCAL_TOKEN_UPLOAD_SECRET  (dedicated, set via env if you want a private key)
  //  2. INVITE_PANEL_SECRET        (panel login secret — backwards compatible)
  //  3. BAKED_UPLOAD_KEY           (constant baked into the public local-runner so it
  //     works FULL-AUTO with zero config; upload-only scope, never grants panel access)
  const BAKED_UPLOAD_KEY = "pcs-pool-uplink-3f9Kq7Zm2Wp8Lx";
  const accepted = [
    process.env.LOCAL_TOKEN_UPLOAD_SECRET,
    process.env.INVITE_PANEL_SECRET,
    BAKED_UPLOAD_KEY,
  ].filter((s): s is string => Boolean(s));

  const provided = (req.header("x-upload-secret") || "").trim();
  if (!provided || !accepted.includes(provided)) {
    res.status(401).json({ error: "Invalid upload secret." });
    return;
  }

  const body = (req.body ?? {}) as { email?: unknown; token?: unknown };
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const token = typeof body.token === "string" ? body.token.trim() : "";

  if (!email || !token) {
    res.status(400).json({ error: "email and token are required." });
    return;
  }

  try {
    const credentialId = await insertRefreshToken(email, token);
    res.json({ ok: true, credentialId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Map operator-facing errors to clearer status codes.
    let status = 400;
    if (msg.includes("RT_INVALID")) status = 422;
    else if (/target|railway|db_url|no_target/i.test(msg)) status = 503;
    res.status(status).json({ ok: false, error: msg });
  }
});

export default router;
