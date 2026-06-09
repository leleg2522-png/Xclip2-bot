import { Router } from "express";

const router = Router();

const PICSART_API = "https://api.picsart.com";
const PICSART_BOARDS_API = "https://picsart.com";

function buildHeaders(authToken: string) {
  return {
    "Authorization": authToken.startsWith("Bearer ") ? authToken : `Bearer ${authToken}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Origin": "https://picsart.com",
    "Referer": "https://picsart.com/",
  };
}

router.post("/picsart/boards", async (req, res) => {
  const { authToken } = req.body as { authToken: string };

  if (!authToken) {
    return res.status(400).json({ error: "authToken is required" });
  }

  try {
    const response = await fetch(
      `${PICSART_BOARDS_API}/api/v1/boards?limit=50&offset=0`,
      { headers: buildHeaders(authToken) }
    );

    if (response.status === 401 || response.status === 403) {
      return res.status(401).json({ error: "Invalid or expired token. Please update your token from the browser." });
    }

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: `Picsart API error: ${response.status} - ${text.slice(0, 200)}` });
    }

    const data = await response.json() as any;

    const boards = (data?.data || data?.boards || data?.results || []).map((b: any) => ({
      id: b.id || b.board_id || String(b.boardId),
      name: b.title || b.name || b.board_name || "Untitled Board",
      mediaCount: b.media_count ?? b.mediaCount ?? b.count ?? null,
      thumbnailUrl: b.cover_image?.url || b.thumbnail || b.coverImage?.url || b.cover || null,
    }));

    return res.json({ boards });
  } catch (err: any) {
    return res.status(500).json({ error: `Network error: ${err.message}` });
  }
});

router.post("/picsart/media", async (req, res) => {
  const { authToken, boardId, limit = 100 } = req.body as { authToken: string; boardId: string; limit?: number };

  if (!authToken || !boardId) {
    return res.status(400).json({ error: "authToken and boardId are required" });
  }

  try {
    const response = await fetch(
      `${PICSART_BOARDS_API}/api/v1/boards/${boardId}/assets?limit=${limit}&offset=0`,
      { headers: buildHeaders(authToken) }
    );

    if (response.status === 401 || response.status === 403) {
      return res.status(401).json({ error: "Invalid or expired token." });
    }

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: `Picsart API error: ${response.status} - ${text.slice(0, 200)}` });
    }

    const data = await response.json() as any;

    const rawItems = data?.data || data?.assets || data?.results || data?.items || [];

    const items = rawItems.map((item: any) => {
      const assetType = item.asset_type || item.type || item.media_type || "image";
      const isVideo = assetType === "video" || assetType === "VIDEO" ||
        (item.url || item.file_url || "").match(/\.(mp4|webm|mov)/i);

      const url = item.original_url || item.file_url || item.url ||
        item.download_url || item.source_url || item.video_url || item.image_url || "";

      const thumbUrl = item.thumbnail_url || item.thumbnail || item.preview_url ||
        item.cover_image?.url || (isVideo ? "" : url) || "";

      const id = String(item.id || item.asset_id || item.resource_id || Math.random());
      const ext = isVideo ? "mp4" : "jpg";
      const filename = item.filename || item.name || `picsart_${id}.${ext}`;

      return {
        id,
        type: isVideo ? "video" : "image",
        url,
        thumbnailUrl: thumbUrl || null,
        filename,
        createdAt: item.created_at || item.createdAt || null,
        prompt: item.prompt || item.description || item.caption || null,
      };
    }).filter((item: any) => item.url);

    return res.json({ items });
  } catch (err: any) {
    return res.status(500).json({ error: `Network error: ${err.message}` });
  }
});

router.post("/picsart/proxy-download", async (req, res) => {
  const { url, authToken, filename } = req.body as { url: string; authToken: string; filename?: string };

  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }

  try {
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer": "https://picsart.com/",
    };

    if (authToken) {
      headers["Authorization"] = authToken.startsWith("Bearer ") ? authToken : `Bearer ${authToken}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Download failed: ${response.status}` });
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const safeFilename = filename || "picsart_media";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);

    const contentLength = response.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    const buffer = await response.arrayBuffer();
    return res.send(Buffer.from(buffer));
  } catch (err: any) {
    return res.status(500).json({ error: `Network error: ${err.message}` });
  }
});

export default router;
