# Wan 3.0 reguler

Wan 3.0 reguler menggunakan Vivareel, bukan lagi Picsart. Wan Uncensored dan
model lain tidak berubah.

## Konfigurasi

Tambahkan `VIVAREEL_API_KEY` melalui pengelola secrets/environment pada server
bot, lalu build dan restart/redeploy bot. Secret di workspace pengembangan
tidak otomatis menyiapkan secret di server Railway.

Jangan memasukkan nilai API key ke Git, ZIP pembaruan, atau log.
Tidak ada migrasi database atau pemindahan key pool untuk perubahan ini.
Paket runtime yang sudah ada tetap digunakan; Dockerfile bot sudah memasang
FFmpeg, yang menyediakan `ffmpeg` dan `ffprobe`.

## Perilaku

- Harga tetap Rp6.000, sumber Vivareel 480p, audio aktif. Tanpa video referensi
  durasi hasil tetap 30 detik.
- Alur wajib: Vivareel 480p → crop logo → Renderful 1080p → kirim hasil.
  Renderful menggunakan pool key yang sudah ada di bot, tanpa biaya saldo
  tambahan yang dibebankan terpisah ke pelanggan.
- Rasio portrait 9:16 atau landscape 16:9; tetap menerima 1–5 gambar referensi.
- Satu gambar memakai first-frame; beberapa gambar memakai image-reference.
- Opsional satu video referensi MP4/MOV, durasi aktual 1–15 detik dan maksimal
  19MB (batas download Telegram bot), tanpa foto atau digabung dengan 1–5 foto.
  Video dikirim biasa atau sebagai dokumen, setelah memilih rasio. Tekan
  **Lanjut ke Prompt** setelah semua referensi diterima. Sebut `Video 1` di prompt.
- Durasi file diperiksa dengan FFprobe sebelum lanjut/charge; metadata durasi
  Telegram tidak dipercaya. Total referensi + hasil tidak boleh melebihi 30 detik:
  durasi hasil = `floor(30 - durasi aktual referensi)`. Referensi 10 detik → hasil
  20 detik, referensi 15 detik → hasil 15 detik. Durasi dan harga ditampilkan
  sebelum pengguna mengirim prompt. Harga tetap Rp6.000, termasuk finishing.
- Dengan video, satu maupun beberapa foto dikirim sebagai `reference_urls`,
  bukan `image_url`; video memakai `reference_video_urls` pada `image_reference`.
- Upload video/foto yang masih berjalan menghalangi lanjut ke prompt. Upload
  lama yang selesai setelah pembatalan/pilihan baru tidak mengubah draft baru.
- Logo VR dipotong otomatis. Sebagian tepi gambar hilang dan area yang tersisa
  dikembalikan ke dimensi sumber 480p sebelum upscale; bukan inpainting.
- Video sumber yang bukan 480p, berdurasi tidak sesuai, atau salah rasio
  ditolak, bukan dikirim dengan label yang salah. Validasi crop menggunakan
  durasi hasil yang disepakati, tidak selalu 30 detik.
- Hasil yang gagal di-crop atau gagal di-upscale tidak diganti dengan video asli
  berlogo maupun video 480p. Pengiriman 1080p wajib berhasil.
- Generate tidak diulang otomatis setelah submit ambigu atau job diterima.
  Gangguan membaca status hanya mengulang pembacaan job yang sama.
- Gagal generate, crop, upscale, atau mengirim hasil memakai refund pada alur
  saldo yang sudah ada. Hanya hasil Renderful 1080p yang dikirim kepada pelanggan.

## Verifikasi lokal

```sh
pnpm run test:vivareel
pnpm run test:video-menu
pnpm run build
```

Tes tersebut menggunakan respons API tiruan dan video sintetis lokal;
tidak menghabiskan poin Vivareel atau memodifikasi saldo pengguna.

Tes langsung terpisah telah membuktikan video referensi 3 detik → video native
sekitar 5 detik, 854×480, 30 fps dengan audio (15 poin). Tes ini belum membuktikan
alur lengkap video referensi → crop → Renderful → Telegram di server produksi.
