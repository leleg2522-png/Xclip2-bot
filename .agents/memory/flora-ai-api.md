---
name: Flora AI public API (Kling 2.6 Motion Control)
description: Working call format for Flora AI generate/upload, key-pool behavior, and disproven "1 key 1 task" assumption
---

# Flora AI API — hasil verifikasi langsung (Jul 2026)

## Format request yang benar
- Base: `https://app.flora.ai/api/v1`, auth `Bearer sk_live_...` per akun (1 akun = 1 workspace sendiri).
- Model motion control: `iv2v-kling-2.6-motion` (mixed-to-video).
- `POST /generate` inputs masuk lewat `params`, **bukan** array `inputs`:
  `params: { image_url, video_url, character_orientation: "video"|"image" }`.
  Pakai `inputs: [...]` → run failed `GENERATION_INPUT_VALIDATION: Field required (image_url)`.
- Upload asset signed-url: response memakai **snake_case** (`form_fields`, `file_field`) — bukan camelCase. Upload multipart ke ImageKit dengan semua form_fields + `fileName` dari response, lalu `POST /assets/{id}/complete`.
- Poll `GET /runs/{run_id}` — job Kling 2.6 MC nyata ~7–15 menit (estimasi resmi 670s). `progress` sering tetap 0 sampai tiba-tiba completed.

## Perilaku key/akun
- **Klaim "1 API key = 1 task" TERBUKTI SALAH**: 1 key free menerima 4 task ($0.471 flat/video), termasuk 2 berjalan paralel — semuanya sukses.
- **Tidak ada endpoint saldo credits** di API publik — satu-satunya sinyal key habis adalah error saat submit (401/402/403/insufficient). Run yang failed karena validasi tetap tercatat charged.
- Bot XclipAI pakai pool `flora_key_pool` (clone pola leonardo_key_pool) dengan rotasi round-robin; **why:** user pakai banyak akun free sekali pakai, key mati dideteksi dari error submit, bukan cek saldo.
- **How to apply:** klasifikasi error key-dead harus ketat — hanya FLORA_AUTH/SUBMIT/UPLOAD failure dengan sinyal 401/402/403/quota; FLORA_RUN_FAILED = error konten, jangan matikan key.
