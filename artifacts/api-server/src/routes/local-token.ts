import { Router, type IRouter } from "express";
import { insertRefreshToken } from "../lib/invite-runner.js";

const router: IRouter = Router();

router.post("/local-token", async (req, res) => {
  // Prefer a dedicated upload secret so the local runner does not need the panel
  // login secret. Falls back to INVITE_PANEL_SECRET so existing configs keep working.
  const secret = process.env.LOCAL_TOKEN_UPLOAD_SECRET || process.env.INVITE_PANEL_SECRET;
  if (!secret) {
    res.status(503).json({ error: "No upload secret is configured on the server." });
    return;
  }

  const provided = (req.header("x-upload-secret") || "").trim();
  if (provided !== secret) {
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
