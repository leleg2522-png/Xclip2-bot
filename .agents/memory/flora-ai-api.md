---
name: Flora AI public API (Kling 2.6 Motion Control)
description: Working call format for Flora AI generate/upload, key-pool behavior, and disproven "1 key 1 task" assumption
---

**Billing error bisa muncul di tahap RUN:** Flora bisa lapor `FLORA_RUN_FAILED [BILLING_NOT_ENOUGH_CREDITS]` setelah job jalan (bukan hanya saat submit/upload). Deteksi key-habis tidak boleh hanya filter tahap pre-run — sinyal billing eksplisit harus selalu membuang key dari pool, apapun tahapnya.

# Flora AI API — hasil verifikasi langsung (Jul 2026)

## Format request yang benar
- Base: `https://app.flora.ai/api/v1`, auth `Bearer sk_live_...` per akun (1 akun = 1 workspace sendiri).
- Model motion control: `iv2v-kling-2.6-motion` (mixed-to-video).
- Kling 2.5 Turbo Pro i2v = `i2v-kling-2.5`, format params sama (image_url + duration '5'|'10') — submit+validasi terverifikasi jalan.
- Kling 2.1 Pro i2v = model `f2v-kling-2.1-pro` (first-frame-to-video): `params: { image_url, duration: '5'|'10' }` — terverifikasi jalan, output 10.04s. TIDAK ada model `i2v-kling-2.1-pro`; `i2v-kling-2.1` = Master. Submit TANPA image_url tetap diterima (charged $0.45) lalu failed GENERATION_INPUT_VALIDATION saat run — validasi input baru terjadi di run, bukan submit.
- `GET /models` (butuh Bearer key) = daftar lengkap model_id + params resmi — selalu cek ini dulu sebelum nebak model id.
- `POST /generate` inputs masuk lewat `params`, **bukan** array `inputs`:
  `params: { image_url, video_url, character_orientation: "video"|"image" }`.
  Pakai `inputs: [...]` → run failed `GENERATION_INPUT_VALIDATION: Field required (image_url)`.
- Upload asset signed-url: response memakai **snake_case** (`form_fields`, `file_field`) — bukan camelCase. Upload multipart ke ImageKit dengan semua form_fields + `fileName` dari response, lalu `POST /assets/{id}/complete`.
- Poll `GET /runs/{run_id}` — job Kling 2.6 MC nyata ~7–15 menit (estimasi resmi 670s). `progress` sering tetap 0 sampai tiba-tiba completed.

## Topaz 4K Video Upscaler
- model_id: `video-upscaler-topaz` (provider: fal, type: video)
- Params: `upscale_factor` (float 1–4, NOT `scale`), `target_fps` (int 16–60)
- Actual cost: $0.13/run (~75s proses, bukan 165s)
- Asset upload: POST /assets → GCS signed URL multipart → POST /assets/{id}/complete → `url` field
- Auth key format: `ak_xxx` (not `sk_live_xxx`)

### /generate required fields (verified Aug 2026)
- `model_id`, `workspace_id`, `project_id` (must start with `prj_`), `type` ("video"), `prompt` (min 1 char), `params`
- `project_id` TIDAK sama dengan `workspace_id` — fetch via GET /projects?workspace_id=xxx → projects[0].project_id
- `prompt` tidak boleh kosong — pakai "upscale to 4K 60fps" sebagai default

### Poll response format
- Result ada di `outputs[]` (array), BUKAN `output` (object singular)
- Field: `outputs[0].url` (type: "videoUrl")

### floraGetWorkspace cache
- Cache key: api_key → `{ workspaceId, projectId }`
- Urutan fetch: GET /workspaces → workspace_id, lalu GET /projects?workspace_id → project_id
- `flora_key_pool` table: id, api_key, status, created_at, dead_at (same pattern as leonardo_key_pool)

## Perilaku key/akun
- **Klaim "1 API key = 1 task" TERBUKTI SALAH**: 1 key free menerima 4 task ($0.471 flat/video), termasuk 2 berjalan paralel — semuanya sukses.
- **Tidak ada endpoint saldo credits** di API publik — satu-satunya sinyal key habis adalah error saat submit (401/402/403/insufficient). Run yang failed karena validasi tetap tercatat charged.
- Bot XclipAI pakai pool `flora_key_pool` (clone pola leonardo_key_pool) dengan rotasi round-robin; **why:** user pakai banyak akun free sekali pakai, key mati dideteksi dari error submit, bukan cek saldo.
- **How to apply:** klasifikasi error key-dead harus ketat — hanya FLORA_AUTH/SUBMIT/UPLOAD failure dengan sinyal 401/402/403/quota; FLORA_RUN_FAILED = error konten, jangan matikan key.
