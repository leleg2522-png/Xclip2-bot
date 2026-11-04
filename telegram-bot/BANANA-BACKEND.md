# Banana image packages — Picsart Banana 2 Lite

Banana Pro, Banana 2 and Banana 2 Lite share Picsart's
`gemini-3.1-flash-lite-image` backend for text-to-image and image-to-image.
Public package names, prices, ratios and the two-reference-photo limit stay
separate and unchanged. The standalone Banana 2.1 · 4K package remains on
`gemini-nano-banana-2.1`.

The Lite model ID is listed in Picsart's public AI Playground catalog and the
deep link at https://picsart.com/ai-models/nano-banana-2-lite/ .
Lite has no output-resolution selector in that catalog. Do not send the
Banana 2.1 `imageSize: "4K"` option or promise 4K for the shared packages.
Deliver original native-resolution files as documents (or temporary download
links), without photo compression. The separate Banana 2.1 route still requires
an actual 4K result.

The existing Picsart account pool handles upload, submit and polling.
No SnapGen or Renderful fallback is active. Accepted jobs must never be replayed
on another provider. Failed generation or delivery refunds the full package
charge.

Offline verification: `pnpm test:banana`, `pnpm test:har-models`, `pnpm build`.
These tests do not perform live paid generation or publish the Railway bot.
