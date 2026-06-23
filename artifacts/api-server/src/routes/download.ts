import { Router, type IRouter } from "express";
import path from "path";
import fs from "fs";

const router: IRouter = Router();

const DOWNLOADS_DIR = path.join(process.cwd(), "downloads");
const ALLOWED = new Set([
  "proof-login.zip",
  "picsart-local-runner.zip",
  "proof-login.js",
  "run.bat",
]);

router.get("/download/:name", (req, res) => {
  const name = req.params.name;
  if (!ALLOWED.has(name)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const file = path.join(DOWNLOADS_DIR, name);
  if (!fs.existsSync(file)) {
    res.status(404).json({ error: "missing" });
    return;
  }
  const type = name.endsWith(".zip")
    ? "application/zip"
    : name.endsWith(".js")
      ? "application/javascript"
      : "text/plain";
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(file).pipe(res);
});

export default router;
