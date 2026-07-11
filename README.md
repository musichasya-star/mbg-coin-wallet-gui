# MBG Coin Wallet GUI

Fondasi awal aplikasi Windows sesuai [walletgui.md](../walletgui.md). Fase pertama menyediakan shell Electron, navigasi utama, tema MBG, dashboard, dan panel sinkronisasi. Fase kedua menambahkan layar unlock dan bridge IPC untuk membaca status node melalui proses utama Electron sehingga RPC tidak bergantung pada CORS renderer.

## Menjalankan

```powershell
npm.cmd install
npm.cmd test
npm.cmd start
```

Saldo wallet masih mock sampai wallet core terhubung. Tinggi blok dan status node dibaca melalui IPC jika aplikasi dapat mengakses endpoint RPC yang dikonfigurasi di `src/renderer/app.js`.

Integrasi pembukaan wallet sekarang dapat menjalankan binary MBG dan command `balance` dari file wallet yang dipilih. Untuk MVP pengujian, password diteruskan hanya ke proses wallet lokal dan tidak ditulis ke log; sebelum rilis produksi harus diganti dengan wallet service/IPC native agar password tidak terlihat pada daftar proses Windows.

Wallet baru sekarang dibuat dengan `mbgcoin-service.exe` dan dibuka sebagai service RPC persisten. GUI memanggil `getAddresses`, `getStatus`, dan `getBalance`, lalu memperbarui sinkronisasi setiap 3 detik. File wallet CLI lama tetap memiliki fallback melalui `mbgcoin-wallet.exe`, tetapi format CLI lama tidak kompatibel langsung dengan container wallet service.

Import wallet mendukung mnemonic 25 kata serta private spend/view keys. Pada build MVP saat ini, secret diteruskan ke proses service lokal dan segera dibersihkan dari form; jangan gunakan build ini untuk dana produksi sebelum input rahasia dipindahkan ke native IPC/stdin yang tidak tampil pada daftar proses Windows.
