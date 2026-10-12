---
name: Flora AI public API (Kling 2.6 Motion Control)
description: Working call format for Flora AI generate/upload, key-pool behavior, and disproven "1 key 1 task" assumption
---

**Billing error bisa muncul di tahap RUN:** Flora bisa lapor `FLORA_RUN_FAILED [BILLING_NOT_ENOUGH_CREDITS]` setelah job jalan (bukan hanya saat submit/upload). Deteksi key-habis tidak boleh hanya filter tahap pre-run — sinyal billing eksplisit harus selalu membuang key dari pool, apapun tahapnya.

Submit returning `charged_cost: 0` is not proof that generation is free or the
account has sufficient credits; a later run can still fail billing.

**Why:** Flora accepted a generation with zero reported submit cost and then
returned `BILLING_NOT_ENOUGH_CREDITS`, without testing input compatibility.

**How to apply:** Classify that result as a credit blocker, not evidence for a
model's reference-duration limits. Inspect the accepted run; never automatically
replay it on another account. A further boundary test needs separate authorization.

# Flora AI API — hasil verifikasi langsung (Jul 2026)

## Format request yang benar
- Base: `https://app.flora.ai/api/v1`, auth `Bearer sk_live_...` per akun (1 akun = 1 workspace sendiri).
- Flora API 2.18.0 memakai field top-level `model` untuk endpoint ID dari `GET /models`, bukan `model_id`. `model_id` dapat diabaikan sehingga workspace default yang berjalan dan params model tujuan ditolak.
- Model motion control: `iv2v-kling-2.6-motion` (mixed-to-video).
- P5 is publicly named “Kling MC V3 Pro P5” but intentionally uses Kling V3
  **Standard**, not V3 Pro, with mandatory 1080p finishing (now Flora/Topaz).

  **Why:** The user first requested V3 Standard, then specifically requested this
  public name and finishing step. “Pro P5” is their chosen display label, not
  permission to switch the underlying model to Pro.

  **How to apply:** Preserve the Standard route and separate P5 from existing
  P2/P3/P4. Do not deliver native fallback if finishing fails; refund in full.
- Kling 2.5 satu-foto I2V = `i2v-kling-2.5` with `{ image_url, duration: '5'|'10' }`; live capability says `image-to-video`. Do not use `f2v-kling-2.5-pro` for one photo: it is `first-last-frame-to-video` and expects `image_urls`.
- Kling 2.1 Pro i2v = model `f2v-kling-2.1-pro` (first-frame-to-video): `params: { image_url, duration: '5'|'10' }` — terverifikasi jalan, output 10.04s. TIDAK ada model `i2v-kling-2.1-pro`; `i2v-kling-2.1` = Master. Submit TANPA image_url tetap diterima (charged $0.45) lalu failed GENERATION_INPUT_VALIDATION saat run — validasi input baru terjadi di run, bukan submit.
- `GET /models` (butuh Bearer key) = daftar lengkap model_id + params resmi — selalu cek ini dulu sebelum nebak model id.
- Untuk katalog UI, ambil `/models?type=image` per akun lalu cocokkan nama tampilan katalog dengan respons live dan simpan `model_id` hasilnya di sesi; jangan bentuk ID dari nama tampilan.

**Why:** model dan ID endpoint yang tersedia berubah mengikuti akun/subscription Flora, sedangkan dokumentasi model publik tidak selalu mencantumkan ID API.

**How to apply:** menu model harus hanya menampilkan generator yang tersedia untuk key aktif; submit memakai `model_id` dari respons `/models`, bukan string yang di-hardcode dari label.
- `POST /generate` inputs masuk lewat `params`, **bukan** array `inputs`:
  `params: { image_url, video_url, character_orientation: "video"|"image" }`.
  Pakai `inputs: [...]` → run failed `GENERATION_INPUT_VALIDATION: Field required (image_url)`.
- Upload asset signed-url: response memakai **snake_case** (`form_fields`, `file_field`) — bukan camelCase. Upload multipart ke ImageKit dengan semua form_fields + `fileName` dari response, lalu `POST /assets/{id}/complete`.
- Poll `GET /runs/{run_id}` — job Kling 2.6 MC nyata ~7–15 menit (estimasi resmi 670s). `progress` sering tetap 0 sampai tiba-tiba completed.

Keep the P4 polling budget long even when the reference video is short.

**Why:** A real P4 generation with a current Railway-pool key and a five-second
reference completed successfully, but took about nine minutes from acceptance to
download. Short input does not imply a short queue/render time.

**How to apply:** Do not shorten the twenty-minute timeout based only on input
duration or treat unchanged running/progress as failure. Continue polling the same
accepted run rather than submitting another paid job.

## Topaz 4K Video Upscaler
- model_id: `video-upscaler-topaz` (provider: fal, type: video)
- Params: `upscale_factor` (float 1–4, NOT `scale`), `target_fps` (int 16–60)
- Untuk input 1080p gunakan `upscale_factor: 2` agar hasil 4K. Faktor 4 meminta 8K dan bisa ditolak provider sebagai `GENERATION_INVALID_PARAMS`.
- Kontrak minimum yang paling kompatibel adalah `params: { video_url, upscale_factor: 2 }`. Parameter opsional model dan target_fps pernah ikut ditolak Flora sebagai `GENERATION_INVALID_PARAMS`; jangan aktifkan tanpa mengecek schema live `/models`.
- Actual cost: $0.13/run (~75s proses, bukan 165s)
- Asset upload: POST /assets → GCS signed URL multipart → POST /assets/{id}/complete → `url` field
- Auth key format: `ak_xxx` (not `sk_live_xxx`)

### /generate required fields (verified Aug 2026)
- `model`, `workspace_id`, `project_id` (must start with `prj_`), `type` ("video"), `prompt` (min 1 char), `params`
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

### Wan 3.0 reference inputs

Wan 3.0's live model variants have different input contracts. The mixed-to-video
variant supports both `image_urls` and `video_urls` arrays, with output duration
options up to `"30"` and resolution `"480p"`. This does NOT mean 30-second output
is valid when a reference video is supplied. The ordinary image-to-video variant instead
requires singular `image_url`; do not add video references to it by guessing.

**Why:** The official live catalog checked on 2026-10-11 distinguishes
`m2v-wan-3-0-gateway` (`mixed-to-video`) from `i2v-wan-3-0-gateway`
(`image-to-video`). Schema support is not a paid-generation test or a guarantee
of exact motion transfer.

**How to apply:** Resolve the account's live schema for the intended capability.
For combined photo/video references, confirm both array fields and the requested
duration/resolution before submitting. Input-video duration/size limits are not
specified by these catalog fields; do not infer them from output duration.

For Wan 3.0 video-reference requests, **total input-video seconds + output
seconds must not exceed 30**. Reference videos total at most 15 seconds, and
reference audio separately totals at most 15 seconds. Native limits allow up to
10 reference images, 5 reference videos and 5 reference audio clips. Reference
image/video/audio types can be combined; first/last-frame types cannot be mixed
with these reference types.

**Why:** The [native Wan 3.0 API reference](https://help.aliyun.com/en/model-studio/wan3-video-generation-api-reference)
documents the combined duration budget, unlike Flora's duration dropdown. A
30-second output plus a nonzero reference video violates this rule even though
Flora accepts the job; its provider error can be generic `GENERATION_INVALID_PARAMS`.

Flora's Wan 3.0 mixed-to-video gateway also enforces a 15-second reference-video
ceiling at runtime. Its exact rejection is: “Video duration exceeds the maximum
allowed. Maximum is 15 seconds.”

**Why:** A whole 30-second reference was explicitly rejected with that message
on an independently authorized account test. A prior account's credit failure
was inconclusive; the live model catalog omits the input limit.

**How to apply:** Do not equate the catalog's 30-second output option with
30-second reference support. A product requiring 30-second uploads needs a
separately designed long-reference strategy, not direct forwarding to this
gateway or silent truncation.

**How to apply:** Measure actual reference duration, validate the aggregate
budget before submission, and choose an integer output duration no larger than
`floor(30 - totalReferenceVideoSeconds)`. Matching the reference's approximate
duration is safer than blindly requesting the catalog maximum. Schema support
still does not prove accurate choreography or original-sound copying; inspect
delivered media. Never replay an accepted or ambiguous paid job.

Multiple character-image references + a dance video + separate reference audio
can deliver native 480p when the combined duration budget is valid. This is not
an identity lock: a generated group can retain the reference dancer's face or
outfit for the central character, especially in its opening frames.

**Why:** Correctly bounded mixed-reference generation delivered all three
characters, while visual inspection showed reference-dancer appearance leaking
into the central character. Explicit reference audio produced a closer music
fingerprint match than the video-audio-only control, but this does not prove
bit-identical soundtrack copying.

**How to apply:** When preserving the source sound matters, supply extracted
audio as `audio_urls` and inspect the actual audio result. Review all character
identities throughout the output; do not market generic Wan mixed-to-video as
equivalent to dedicated Kling Motion Control or promise exact identity/music.

- A valid Flora key can return a workspace successfully but an empty project list.
  Authentication and DB `available` status do not prove the account is ready to generate.

  **Why:** Live API checks confirmed an authenticated account with no project while
  other pool accounts had valid projects. Missing setup is not evidence of exhausted credits.

  **How to apply:** Before paid submission, missing workspace/project may skip that
  key for the current request without marking it dead. Do not auto-create projects
  or retry an accepted or ambiguous paid submission to work around missing setup.
- **Klaim "1 API key = 1 task" TERBUKTI SALAH**: 1 key free menerima 4 task ($0.471 flat/video), termasuk 2 berjalan paralel — semuanya sukses.
- **Tidak ada endpoint saldo credits** di API publik — satu-satunya sinyal key habis adalah error saat submit (401/402/403/insufficient). Run yang failed karena validasi tetap tercatat charged.
- Flora kadang membungkus gangguan upstream sebagai HTTP 400 `input_validation_error` dengan pesan generik `Server Error`. Jika belum ada `run_id`, retry setelah jeda tanpa mematikan/mengecualikan key (pool bisa hanya punya satu key); setelah ada `run_id`, jangan pernah resubmit.
- Bot XclipAI pakai pool `flora_key_pool` (clone pola leonardo_key_pool) dengan rotasi round-robin; **why:** user pakai banyak akun free sekali pakai, key mati dideteksi dari error submit, bukan cek saldo.
- **How to apply:** klasifikasi error key-dead harus ketat — hanya FLORA_AUTH/SUBMIT/UPLOAD failure dengan sinyal 401/402/403/quota; FLORA_RUN_FAILED = error konten, jangan matikan key.
