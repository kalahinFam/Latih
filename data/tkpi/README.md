# Data TKPI

## ⚠️ Status: PLACEHOLDER — belum diverifikasi

`tkpi.json` saat ini berisi **data contoh yang belum diverifikasi terhadap
Tabel Komposisi Pangan Indonesia resmi.** Setiap baris punya `"verified": false`,
dan aplikasi menampilkan peringatan eksplisit kepada pengguna selama flag itu
masih false.

**Data ini tidak boleh dipakai di paper, demo yang dinilai, atau video** sebelum
diganti dengan angka dari sumber resmi. Angka gizi yang salah dalam produk yang
mengklaim "grounded pada TKPI" adalah masalah kredibilitas yang jauh lebih besar
daripada modul nutrisi yang cakupannya kecil.

Alasan status ini ada: mesin retrieval, verifier grounding, dan endpoint-nya
bisa dibangun dan diuji penuh tanpa data final. Memisahkan keduanya membuat
pekerjaan berjalan paralel — bukan berarti datanya boleh dilewat.

## Cara mengganti dengan data resmi

**Sumber:**
- [panganku.org](https://www.panganku.org/id-ID/view) — basis data resmi,
  1.146 entri, satu halaman per bahan
- [Repository Kemenkes](https://repository.kemkes.go.id/book/668) — buku TKPI

**Target realistis: 100–250 bahan pangan umum Indonesia.** Bukan 1.146. Pilih
yang benar-benar muncul dalam pertanyaan pengguna: beras, tempe, tahu, telur,
ayam, ikan, sayuran umum, buah umum.

Untuk setiap baris, isi:

| Field | Isi |
|---|---|
| `code` | Kode pangan resmi TKPI |
| `name` | Nama sesuai TKPI |
| `aliases` | Nama sehari-hari yang mungkin diketik pengguna |
| `basisG` | Selalu `100` — TKPI menyatakan semuanya per 100 g |
| `energyKcal`, `proteinG`, `fatG`, `carbG`, `fiberG` | Angka dari tabel |
| `source` | Sumber persis + halaman, mis. `"TKPI 2017 hal. 42"` |
| `verified` | `true` **hanya** setelah seseorang mencocokkan barisnya dengan sumber |

## Validasi

```bash
npm run check:tkpi
```

Memeriksa: kode duplikat, basis bukan 100 g, dan **konsistensi Atwater** —
apakah protein×4 + karbo×4 + lemak×9 kira-kira sama dengan energi yang
tercatat. Baris yang meleset jauh hampir selalu salah salin, dan menemukannya
di sini jauh lebih murah daripada menemukannya di jawaban yang sedang dinilai.

Skrip ini juga melaporkan berapa baris yang masih `verified: false`.
