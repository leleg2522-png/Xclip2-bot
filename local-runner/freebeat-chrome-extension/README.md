# Freebeat Seedance Bridge — Ekstensi Chrome

Ekstensi ini mengambil order Seedance 2.5 dari Telegram bot melalui Chrome normal
yang kamu login sendiri. Tidak memakai Playwright dan tidak membuka browser otomatis.

## Pasang sekali

1. Buka Google Chrome biasa.
2. Ketik `chrome://extensions` di bar alamat lalu Enter.
3. Aktifkan **Developer mode** di pojok kanan atas.
4. Klik **Load unpacked**.
5. Pilih folder `freebeat-chrome-extension`.
6. Klik ikon puzzle Chrome lalu pilih **Freebeat Seedance Bridge**.

## Sambungkan

1. Dari Telegram bot sebagai admin, kirim `/bridgecode`.
2. Ketik URL Railway bot dan kode pendek yang dikirim bot di halaman ekstensi.
3. Klik **Sambungkan Bridge** dan izinkan koneksi saat Chrome bertanya.
4. Klik **Buka Freebeat**, login seperti biasa, lalu refresh halaman Freebeat sekali.
5. Popup ekstensi akan berubah menjadi **Bridge siap menerima order**.

Biarkan Chrome dan tab Freebeat terbuka saat ingin menerima order. Ekstensi memeriksa
antrean setiap 30 detik. Jika tab ditutup atau PC mati, order menunggu dan akan
direfund oleh bot bila melewati batas waktu.