# Microdrama — admin-only prototype

This feature is part of the existing XclipAI bot. It does not expose a public
menu or call any customer saldo deduction/refund functions.

## Configuration

The process running the bot needs `BUATSIMPEL_API_KEY`, `DEAPI_API_KEY`, and its
existing Telegram/PostgreSQL credentials. Credentials in the Replit workspace
are not automatically configured on a separate Railway service.

`MICRODRAMA_LLM_MODEL` optionally selects the initial LLM gateway alias
(default `gpt-6-luna`). `/microdramamodel` lists live enabled aliases and lets
each admin choose a default for **new** projects. Gateway aliases do not prove
the identity of the model behind them. There is no automatic model fallback.

The existing Dockerfile already installs `ffmpeg`/`ffprobe`. Schema setup runs
before Telegram handlers start; failure disables only this feature.

## Workflow

### Aktivasi manual pada service Railway yang sudah ada

1. Tunggu pekerjaan video aktif selesai sebelum deploy. Restart bisa memutus
   pekerjaan fitur lama dan menghapus file/link unduhan sementara.
2. Pastikan perubahan folder `telegram-bot/` sudah dikirim ke repo dan branch
   yang menjadi sumber **service bot yang sekarang**. Perubahan lokal di Replit
   tidak otomatis menjadi kode build Railway; redeploy versi lama saja tidak
   akan menambahkan fitur ini.
3. Pada **Variables** service bot tersebut, tambahkan `BUATSIMPEL_API_KEY` dan
   `DEAPI_API_KEY` menggunakan nilai aslinya secara privat. Jangan mengganti
   token Telegram, koneksi database, atau key fitur lain. Bila key DeAPI sudah
   ada, tidak perlu membuat key baru.
4. `MICRODRAMA_LLM_MODEL=gpt-6-luna` bersifat opsional. Contoh nama variabel
   tanpa kredensial ada di `.env.example`; file itu bukan konfigurasi rahasia.
5. Pertahankan service dan konfigurasi deploy yang sudah berjalan. Paket bot
   memakai `telegram-bot/Dockerfile` dengan konteks build folder `telegram-bot`
   (menginstal ffmpeg dan menjalankan `node dist/index.js`). Jangan membuat
   service/salinan bot kedua dengan token Telegram yang sama.
6. Deploy kode terbaru, lalu periksa log startup: `Microdrama admin storage
   ready` menandakan tabel fitur berhasil disiapkan. Jika muncul `Microdrama
   storage initialization failed`, fitur ini nonaktif; jangan mengirim render
   berbayar sebelum penyimpanan siap.
7. Dari akun admin, buka chat pribadi bot dan jalankan `/microdrama`, buat
   naskah, lalu minta estimasi. Berhenti sebelum **Setuju biaya & render** bila
   hanya ingin memeriksa aktivasi tanpa biaya video. Pembuatan naskah tetap
   memakai kuota LLM. Akun non-admin tidak boleh mengakses fitur ini.

Status deploy dan runtime Railway perlu diperiksa langsung pada service yang
benar. Lulus build/test lokal bukan bukti fitur sudah aktif di Railway.

### Penggunaan

1. Open a private conversation and send `/microdrama`.
2. Choose **Microdrama baru** and send an idea. This consumes LLM quota.
3. Review the title, characters, location, actions and Indonesian dialogue.
   **Revisi naskah** accepts feedback and consumes another LLM request.
4. **Lihat estimasi biaya** requests non-billable video quotes.
5. **Setuju biaya & render** explicitly approves the displayed provider budget.
6. Receive a joined MP4. `/microdrama` or `/microdramastatus` shows saved status
   after a restart; **Lanjutkan job yang sama** resumes accepted jobs.

Two sequential MiniMax H3 Turbo clips, approximately ten seconds each:
`MiniMaxH3_33B_Turbo_INT8`, 768×1344, 240 frames, 24fps. The second clip uses
the first clip's last frame. Delivery is an exact 9:16 crop (756×1344), not
upscaled. Original generated audio is retained; subtitles are not added.
Generation can take tens of minutes. Continuity/lip-sync are not guaranteed.

## Costs and safety

- LLM quota and DeAPI wallet costs are **real provider costs**, even in admin
  mode. Customer bot saldo is untouched.
- Each video quote must be exact, positive and at most US$0.30. Approval expires
  after ten minutes. The second quote initially uses a same-size placeholder;
  its actual frame is re-quoted before submission. Any price increase over the
  approved per-scene amount stops submission.
- Persistent per-project PostgreSQL advisory locks prevent concurrent workers
  and double-tap duplicate submissions. One unfinished project per admin;
  at most two microdrama operations across instances, leaving DB capacity
  available for the bot's existing features.
- Every paid video submission is marked attempted **before** calling DeAPI.
  Accepted IDs and result URLs are saved. Poll/download/assembly/delivery
  retries never submit another job for an accepted clip.
- A timeout, malformed submit response, or crash without a saved ID becomes
  **uncertain**. That project cannot render again. Inspect the provider's
  dashboard before making a new project; cancellation cannot cancel/refund an
  upstream accepted job.
- A terminal provider failure stops the project. Successful earlier clips may
  already have consumed provider balance; the prototype does not promise
  provider refunds or regenerate them.
- Intermediate MP4s are temporary. Resumption downloads saved provider result
  URLs; it depends on those URLs remaining available. Save the delivered
  Telegram file. Large-file download links use the bot's existing temporary
  hosting and expire or disappear on restart.
- Nonscript commands/menu actions leave idea-entry mode. After a restart,
  `/microdrama` restores it. **Pulihkan draf setelah restart** unlocks a
  stranded writing/quoting state without automatically consuming LLM quota.

## Validation

`pnpm --dir telegram-bot run test:microdrama` runs offline provider, workflow,
authorization, replay-protection, Telegram handler and real ffmpeg fixture
checks. `pnpm --dir telegram-bot run build` compiles the bot. No live paid
render is required by the test suite.

`pnpm --dir telegram-bot run test:microdrama-pg` additionally checks real
cross-connection locks and schema constraints in a disposable schema on the
workspace's **development** `DATABASE_URL`, never `RAILWAY_DATABASE_URL`.
