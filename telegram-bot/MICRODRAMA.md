# AI episode director — admin only

This feature is part of the existing XclipAI bot. It does not expose a public
menu or call any customer saldo deduction/refund functions.

## Episode 1–20 menit

`/microdrama` atau `/episode` membuka sutradara episode. Pilih tombol durasi
atau ketik `/microdrama 7`; semua bilangan bulat 1–20 didukung. Pilihan awal
yang disarankan 1 menit. Status: `/microdramastatus`.

1. Kirim ide. Botelexkey (`claude-fable-5.1`) menyusun bible (alur, wajah/pakaian/suara karakter,
   lokasi, gaya visual). Revisi bible tersedia sebelum membuat referensi.
2. Minta estimasi dan setujui **biaya referensi**. Gambar menggunakan FLUX.2
   Klein; maksimal dua karakter dewasa dan tiga lokasi. Ada cadangan dua
   gambar ulang yang hanya dikirim bila diminta.
3. Periksa gambar di Telegram. `/episoderef char_ID` atau
   `/episoderef loc_ID` mengulang gambar dalam cadangan tersebut. Kunci
   referensi untuk memulai penulisan storyboard.
4. Sutradara menulis dua adegan per menit, tiga shot per adegan, sepuluh
   detik per shot: **6–120 shot**. Kamera, blocking, kondisi awal/akhir,
   dialog dan kedua prompt disimpan per shot. Unduh melalui
   `/episodescript`. Ini storyboard **tertulis**, bukan gambar hasil render.
5. Minta estimasi **produksi** dan setujui batas USD. Estimasi mencakup
   gambar storyboard, video MiniMax, transkripsi, dan maksimal dua retake
   total. Harga actual dicek lagi sebelum tiap submit. Quote gambar memakai
   jumlah referensi terbesar agar adegan dengan dua karakter tidak menerima
   anggaran terlalu kecil.
6. Gambar storyboard memakai referensi wajah + lokasi yang disetujui
   (maksimal tiga input). LLM vision memeriksa gambar sebelum submit video.
   Hanya shot kedua dalam suatu adegan yang boleh memakai last-frame shot
   pertama; tidak ada rantai last-frame sepanjang episode.
7. Video dirender dengan native audio. Tiga sampel frame diperiksa terhadap
   referensi. Audio ditranskripsi terpisah dan dicocokkan dengan dialog.
   Ada paling banyak satu retake otomatis per shot dan dua secara keseluruhan.
   Submit ambigu atau kegagalan provider **bukan** alasan retry otomatis.
8. Penolakan QA dijeda jika cadangan otomatis habis. Admin melihat
   storyboard atau pratinjau klip yang bermasalah sebelum memilih retake
   tambahan dalam cadangan atau menerima secara eksplisit meski ada catatan.
   Override dicatat dan disebutkan pada hasil final.
9. Penyuntingan lokal memotong tiap shot ke sepuluh detik, menormalkan
   volume, menggabungkan video 756×1344 (9:16 tanpa upscale), lalu menambahkan
   track subtitle berbasis waktu transkripsi. File SRT juga dikirim terpisah;
   tampilan subtitle pada player Telegram tidak dijamin.

**Biaya:** persetujuan quote berlaku sepuluh menit. Batas USD hanya untuk
media, bukan tagihan LLM. Bible, revisi, naskah, dan pemeriksaan vision memakai
kuota LLM terpisah; jumlah permintaan ditampilkan. Saldo bot tidak dipotong.
Reservasi biaya konservatif tidak dibatalkan hanya karena respons submit
hilang; biaya provider yang sudah terpakai tidak otomatis kembali.

**Waktu/kualitas:** render berurutan dapat memerlukan berjam-jam hingga lebih
dari sehari untuk episode panjang. Pemeriksaan vision berbasis sampel dan
transkripsi bukan jaminan identitas wajah/suara, akurasi semua dialog, atau
lip-sync sempurna. Native audio menggunakan arahan suara, belum referensi
suara/voice cloning. Belum ada musik latar tambahan.

**Jeda/pemulihan:** tombol jeda dicatat di kolom terpisah agar penyimpanan
progres tidak menghapus permintaan jeda. Job yang sudah diterima disimpan;
tidak ada submit berikutnya setelah pemeriksaan jeda. Resume memakai ID job
dan akun asal. Submit tanpa ID terkonfirmasi diblokir dari pengiriman ulang.
Permintaan LLM yang terputus perlu pemulihan eksplisit karena pengulangan
dapat memakai kuota lagi. Menghentikan saat proyek masih sibuk meminta jeda;
setelah berhenti pada checkpoint, tekan hentikan lagi untuk menutup proyek.

Referensi dan storyboard JPEG tersimpan immutable di PostgreSQL. Video
intermediate hanya cache lokal sementara; cache yang hilang dicoba pulihkan
dari **job yang sama**, selama provider masih menyimpan hasil. Tidak ada
regenerasi berbayar bila hasil lama sudah hilang. Video final besar disajikan
melalui mekanisme download bot yang sudah ada: maksimal 24 jam dan hilang
pada restart. Simpan file segera; ini belum arsip video permanen.

### Prototipe lama

Prototipe dua-shot sekitar 20 detik tetap terpisah:
`/microdramatest` dan `/microdramateststatus`. Job lama tidak dikonversi atau
ditimpa menjadi episode. Satu admin hanya boleh mempunyai satu proyek aktif.
`/microdramamodel` berlaku untuk default proyek baru pada kedua alur.

### Verifikasi lokal

- `pnpm --dir telegram-bot run test:episode`: perjalanan Telegram offline,
  rentang durasi, budget, locking referensi, paid-submit safety, retake/QA,
  pemulihan, dan penyuntingan FFmpeg **60 detik** memakai media sintetis.
- `pnpm --dir telegram-bot run test:microdrama`: regresi prototipe lama.
- `pnpm --dir telegram-bot run test:microdrama-pg`: schema sementara di
  database **development**, termasuk asset immutable dan jeda lintas save.
- `pnpm --dir telegram-bot run build`.

Tes otomatis tidak mengirim job media live dan tidak melakukan deploy.
Uji penuh episode berbayar harus tetap dimulai secara sadar di bot setelah
estimasi aktual disetujui.

## Configuration

The process running the bot needs `BOTELEX_API_KEY` and its existing
Telegram/PostgreSQL credentials. DeAPI credentials come exclusively from the
Railway `deapi_key_pool` table; there is no runtime `DEAPI_API_KEY` fallback.
Credentials in the Replit workspace are not automatically configured on a
separate Railway service.

`MICRODRAMA_LLM_MODEL` optionally selects the initial LLM gateway alias
(default `claude-fable-5.1`). `/microdramamodel` lists live enabled aliases and lets
each admin choose a default for **new** projects. Gateway aliases do not prove
the identity of the model behind them. There is no automatic model fallback.

The existing Dockerfile already installs `ffmpeg`/`ffprobe`. Schema setup runs
before Telegram handlers start; failure disables only this feature.

## Deployment dan referensi prototipe

### Aktivasi manual pada service Railway yang sudah ada

1. Tunggu pekerjaan video aktif selesai sebelum deploy. Restart bisa memutus
   pekerjaan fitur lama dan menghapus file/link unduhan sementara.
2. Pastikan perubahan folder `telegram-bot/` sudah dikirim ke repo dan branch
   yang menjadi sumber **service bot yang sekarang**. Perubahan lokal di Replit
   tidak otomatis menjadi kode build Railway; redeploy versi lama saja tidak
   akan menambahkan fitur ini.
3. Pada **Variables** service bot tersebut, tambahkan `BOTELEX_API_KEY`
   secara privat. Key DeAPI disimpan di database, bukan Variables bot.
   Jangan mengganti token Telegram, koneksi database, atau key fitur lain.
4. `MICRODRAMA_LLM_MODEL=claude-fable-5.1` bersifat opsional. Contoh nama variabel
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

### Pool key DeAPI

Admin dapat menggunakan `/deapipool`, `/adddeapikey KEY`, `/nonaktifdeapikey ID`,
dan `/restoredeapikey ID` di chat pribadi bot. Batch input didukung, maksimal
100 key per pesan. Pesan berisi key dihapus setelah dibaca; daftar hanya
menampilkan ID dan status, bukan key atau potongannya.

Key reusable, dipilih bergantian secara atomik. Pergantian akun hanya terjadi
saat quote non-billable: 401 menonaktifkan key; 402/403 hanya melewati akun
tersebut untuk permintaan ini, karena 403 bisa berarti batas paket/izin.
Tidak ada pengecekan saldo lewat endpoint account yang bisa menolak izin.

Sebelum submit, ID key disimpan bersama marker percobaan. Submit, polling,
dan pemulihan job selalu memakai key asal, termasuk jika key telah
dinonaktifkan untuk pemilihan baru. Job lama tanpa ID key tidak ditebak atau
dipindah akun. Tidak ada penghapusan/edit nilai key agar binding job tetap
stabil; tambahkan key baru lalu nonaktifkan ID lama.

`pnpm --dir telegram-bot run setup:deapi-pool -- --apply` mengimpor satu kali
`DEAPI_API_KEY` yang ada di environment setup ke database Railway. Script
memeriksa tabel penanda target bot, menggunakan transaksi, dan tidak mencetak
nilai kredensial. Menjalankan ulang tidak menduplikasi atau mengaktifkan
kembali key yang dinonaktifkan. Bot tidak memerlukan variabel itu setelah
impor, dan tidak mengimpor ulang otomatis saat restart.

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

`pnpm --dir telegram-bot run test:deapi-pool` checks rotation, persistent
credential binding, admin access and redaction without live paid requests.

`pnpm --dir telegram-bot run test:microdrama-pg` additionally checks real
cross-connection locks and schema constraints in a disposable schema on the
workspace's **development** `DATABASE_URL`, never `RAILWAY_DATABASE_URL`.
