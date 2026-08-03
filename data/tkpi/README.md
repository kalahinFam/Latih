# Data TKPI

`tkpi.json` berisi **1.144 bahan pangan** hasil ekstraksi otomatis dari
[panganku.org](https://www.panganku.org/id-ID/view), basis data resmi Tabel
Komposisi Pangan Indonesia. Setiap baris mencantumkan kode pangan resminya,
sehingga tiap angka bisa ditelusuri balik ke sumbernya.

| | |
|---|---|
| Total baris | 1.144 |
| Bisa disitir | 1.133 |
| Dikecualikan (`suspect`) | 11 |
| Median energi | 143 kkal per 100 g |

## Apa arti `verified: true`

**Bukan** "manusia membaca 1.144 baris satu per satu." Artinya: seseorang
membandingkan **sampel acak** terhadap halaman sumber, menemukan ekstraksinya
setia, lalu menerima tabelnya.

Bedanya penting karena paper mendeskripsikan proses ini. Metode dan ukuran
sampelnya tercatat di `meta.verification` di dalam berkasnya sendiri, bukan di
ingatan seseorang.

## Sebelas baris yang dikecualikan

Pemeriksaan Atwater — protein×4 + karbo×4 + lemak×9 seharusnya kira-kira sama
dengan energi tercatat — menemukan 11 baris yang **angkanya bertentangan dengan
dirinya sendiri**. Contoh:

| Kode | Bahan | Masalah |
|---|---|---|
| `DR004` | Andewi (endive), sayuran daun segar | Energi 226 kkal, makro hanya menghasilkan 29 kkal |
| `BR033` | Umbi Uwi segar | Karbohidrat 82,3 g, tapi energi tercatat 120 kkal — karbonya saja sudah 329 kkal |
| `GP071` | Jukku pallu kaloa | Energi 15 kkal, makro menghasilkan 135 — kemungkinan digit hilang |

**Sudah dicocokkan langsung ke halaman sumber: angkanya memang begitu di
panganku.org.** Ini kesalahan pada data yang dipublikasikan, bukan pada
ekstraksi kami.

Baris-baris itu **tetap disimpan** demi provenance, tapi ditandai `suspect` dan
**dikecualikan dari retrieval**. Menghapus data resmi diam-diam akan lebih
buruk; menyitir angka yang sudah kami tahu bertentangan dengan dirinya sendiri
juga tidak bisa diterima.

Sekitar 1% basis data resmi tidak konsisten secara internal. Itu temuan yang
layak masuk subbagian Responsible AI di paper — sistem yang grounded pada
sumber eksternal tetap harus memvalidasi sumbernya.

## Perintah

```bash
npm run fetch:tkpi                        # ambil ulang dari panganku.org (±6 menit)
npm run fetch:tkpi -- --limit 50          # sampel kecil untuk uji coba
npm run check:tkpi                        # validasi struktur + Atwater
npm run verify:tkpi -- --sample 15 --by "Nama"   # tandai terverifikasi
```

`fetch:tkpi` bersifat sopan: satu permintaan pada satu waktu dengan jeda 250 ms.
Ini layanan publik Kemenkes, dan seluruh tabel hanya butuh beberapa menit — tidak
ada alasan membebaninya.

## Skema per baris

| Field | Isi |
|---|---|
| `code` | Kode pangan resmi TKPI, mis. `DR001` |
| `name` | Nama sesuai TKPI |
| `aliases` | Nama sehari-hari yang mungkin diketik pengguna |
| `basisG` | Selalu `100` |
| `energyKcal`, `proteinG`, `fatG`, `carbG`, `fiberG` | Angka per 100 g |
| `group` | Kelompok pangan |
| `source` | `panganku.org TKPI, kode <kode>` |
| `verified` | Sudah diterima lewat pemeriksaan sampel |
| `suspect` | Angka sumber tidak konsisten — dikecualikan dari retrieval |
