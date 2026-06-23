import { Router, type IRouter } from "express";
import path from "path";
import fs from "fs";

const router: IRouter = Router();

const DOWNLOADS_DIR = path.join(process.cwd(), "downloads");
const ALLOWED = new Set(["proof-login.zip", "picsart-local-runner.zip"]);

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
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.setHeader("Content-Type", "application/zip");
  fs.createReadStream(file).pipe(res);
});

export default router;
