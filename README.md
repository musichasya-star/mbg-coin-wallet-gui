# MBG Coin Wallet GUI

Wallet desktop Windows untuk MBG Coin. Aplikasi menyediakan pembuatan dan import wallet, sinkronisasi, kirim/terima MBG, riwayat transaksi persisten, CPU mining lokal, Optimize/Fusion Transaction, backup, dan failover otomatis Node 1/Node 2.

## Installer Windows

Unduh installer terbaru dari halaman [GitHub Releases](https://github.com/musichasya-star/mbg-coin-wallet-gui/releases).

1. Unduh `MBG-Coin-Wallet-Setup-<version>-x64.exe`.
2. Cocokkan SHA-256 dengan file checksum pada release.
3. Jalankan installer, pilih folder instalasi, lalu buka **MBG Coin Wallet**.
4. Windows SmartScreen dapat menampilkan peringatan karena build komunitas ini belum memakai sertifikat code-signing komersial. Pastikan file berasal dari repository resmi dan checksum cocok.

Build saat ini ditujukan untuk testnet/pengujian publik. Gunakan wallet dan dana khusus pengujian sampai audit keamanan serta code-signing produksi selesai.

## Menjalankan dari source

```powershell
npm.cmd install
npm.cmd test
npm.cmd start
```

## Membuat installer

```powershell
npm.cmd run dist:win
```

Hasil build tersedia di folder `dist/`.

## Node publik

- Primary: `https://node1.mbgcoin.my.id`
- Failover: `https://node2.mbgcoin.my.id`

Wallet berpindah otomatis ke Node 2 ketika Node 1 offline dan kembali ke Node 1 setelah pulih.

## Keamanan

- Password, mnemonic, dan private key tidak dikirim ke node publik.
- Jangan membagikan file wallet, mnemonic, private spend key, atau private view key.
- Simpan backup wallet secara offline.
- Verifikasi checksum installer sebelum memasang aplikasi.
