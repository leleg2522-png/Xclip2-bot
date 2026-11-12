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

- Harga tetap Rp6.000, durasi 30 detik, sumber Vivareel 480p, audio aktif.
- Alur wajib: Vivareel 480p → crop logo → Renderful 1080p → kirim hasil.
  Renderful menggunakan pool key yang sudah ada di bot, tanpa biaya saldo
  tambahan yang dibebankan terpisah ke pelanggan.
- Rasio portrait 9:16 atau landscape 16:9; tetap menerima 1–5 gambar referensi.
- Satu gambar memakai first-frame; beberapa gambar memakai image-reference.
- Logo VR dipotong otomatis. Sebagian tepi gambar hilang dan area yang tersisa
  dikembalikan ke dimensi sumber 480p sebelum upscale; bukan inpainting.
- Video sumber yang bukan 480p, berdurasi tidak sesuai, atau salah rasio
  ditolak, bukan dikirim dengan label yang salah.
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
