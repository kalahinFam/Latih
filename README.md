# LATIH — Pelatih Pribadi AI

Pelatih kebugaran berbasis AI yang berjalan di browser ponsel. Mengamati latihan
lewat kamera, menghitung repetisi, dan mengoreksi form secara real-time —
**seluruh pemrosesan citra terjadi di perangkat.**

Datathon 2026, Ristek Fasilkom UI — University Track. Tim **Kalahin Fam**,
Universitas Indonesia.

---

## Status saat ini

Fast loop sudah berjalan: kamera → pose estimation → sudut sendi → penghitung
repetisi → koreksi form. Slow loop (narasi LLM per set) dan modul nutrisi TKPI
belum diimplementasikan.

| Komponen | Status |
|---|---|
| Pose estimation on-device (MediaPipe) | ✅ berjalan |
| Penghitung repetisi (push-up, squat) | ✅ berjalan |
| Koreksi form deterministik + cue | ✅ berjalan |
| Instrumentasi latensi & FPS | ✅ berjalan |
| PWA installable + offline | ✅ berjalan |
| Ekstraksi fitur per repetisi | ✅ berjalan |
| Harness evaluasi rep-count | ✅ berjalan |
| Alat anotasi (video → keypoint berlabel) | ✅ berjalan |
| Slow loop (narasi LLM per set) | ✅ berjalan |
| TTS Bahasa Indonesia (cue + narasi) | ✅ berjalan |
| Klasifier form (ONNX) | ⬜ belum |
| Nutrisi TKPI + verifier grounding | ⬜ belum |

---

## Menjalankan

**Prasyarat:** Node.js 20 atau lebih baru.

```bash
git clone https://github.com/kalahinFam/Latih.git
cd Latih
npm install                 # SDK OpenAI untuk serverless function
cd web && npm install
npm run dev
```

Untuk umpan balik pelatih AI, salin `.env.example` menjadi `.env` di root lalu
isi `OPENAI_API_KEY`. **Tanpa kunci, fast loop tetap berjalan penuh** —
penghitung repetisi dan cue koreksi tidak butuh jaringan sama sekali; hanya
narasi antar-set yang dilewati.

Buka **http://localhost:5174** (atau port yang ditampilkan), tekan **Mulai**,
lalu izinkan akses kamera.

`npm install` tidak mengunduh model. Saat `npm run dev` dijalankan pertama kali,
skrip `setup:assets` otomatis menyalin runtime WASM dari `node_modules` dan
mengunduh dua model pose (~48 MB total). Ini hanya terjadi sekali — jalankan
berikutnya akan melewatinya.

### Menguji di ponsel

Kamera hanya bisa diakses lewat **HTTPS**. Membuka alamat LAN seperti
`http://192.168.x.x:5174` akan ditolak browser. Gunakan tunnel:

```bash
npx cloudflared tunnel --url http://localhost:5174
```

Buka URL `https://….trycloudflare.com` yang tercetak di ponsel.

### Menguji instalasi PWA dan mode offline

Service worker sengaja hanya aktif di build produksi — di mode dev ia berkelahi
dengan hot reload.

```bash
npm run build
npm run preview
```

Lalu arahkan tunnel ke port preview. Di Chrome Android akan muncul prompt
**"Install app"**. Setelah terpasang, matikan koneksi internet: penghitung
repetisi dan cue tetap berjalan penuh.

---

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm run dev` | Server pengembangan |
| `npm test` | Unit test (79 tes) |
| `npm run typecheck` | Pemeriksaan tipe tanpa build |
| `npm run build` | Build produksi ke `dist/` |
| `npm run preview` | Menyajikan hasil build (untuk uji PWA) |
| `npm run setup:assets` | Mengambil ulang model + WASM |
| `npm run gen:icons` | Membangkitkan ulang ikon PWA |

---

## Arsitektur

```
┌──────────── BROWSER — on-device, frame tidak pernah keluar ─────────────┐
│  Kamera → MediaPipe PoseLandmarker (WASM/GPU) → 33 landmark @ ~30fps    │
│      ↓                                                                  │
│  FAST LOOP (TypeScript murni, tanpa DOM)                                │
│    sudut sendi → state machine rep-count → pemeriksaan form → cue       │
│      ↓ per set selesai: JSON statistik agregat                          │
└────────────────────────────┬────────────────────────────────────────────┘
                             │  angka saja — tanpa frame, tanpa koordinat
                    ┌────────▼─────────┐
                    │  API (belum ada) │  narasi LLM + nutrisi TKPI
                    └──────────────────┘
```

### Struktur direktori

```
web/src/
├── core/          ← LOGIKA MURNI. Tanpa DOM, tanpa MediaPipe.
│   ├── angles.ts       landmark → sudut sendi
│   ├── repCounter.ts   state machine histeresis
│   ├── rules.ts        pemeriksaan form deterministik
│   ├── repWindow.ts    buffer frame per repetisi
│   ├── features.ts     window per rep → tensor 32×12 (input klasifier)
│   ├── setSummary.ts   agregasi per set + kontrak privasi
│   └── metrics.ts      instrumentasi FPS & latensi
├── pose/          ← satu-satunya file yang tahu MediaPipe ada
└── ui/            ← kamera, overlay skeleton, HUD
```

`core/` sengaja dijaga murni: skrip evaluasi berbasis Node meng-import modul
yang **sama persis** dengan yang berjalan di aplikasi. Tidak ada duplikasi
logika, jadi angka yang dilaporkan di paper dijamin berasal dari kode yang benar-
benar dipakai produk.

Dua hal yang membuat ini bekerja, dan yang akan merusaknya kalau diubah:

- **Setiap import relatif memakai ekstensi `.ts` eksplisit.** Node ESM tidak
  menebak ekstensi seperti bundler. Menghapusnya membuat skrip evaluasi gagal
  resolve, meski aplikasi tetap jalan.
- **`erasableSyntaxOnly` aktif di `tsconfig.json`.** Ini melarang sintaks
  TypeScript yang menghasilkan kode saat runtime (enum, parameter property),
  sehingga Node bisa sekadar melucuti tipe tanpa mengompilasi.

---

## Slow loop — narasi pelatih per set

Tekan **Selesai set** setelah selesai. Klien mengirim ringkasan set ke
`/api/coach`, yang mengembalikan narasi Bahasa Indonesia dua sampai tiga
kalimat plus satu fokus untuk set berikutnya.

**Yang keluar dari perangkat hanyalah ringkasan itu:** jumlah repetisi, sudut
sendi dalam derajat, durasi, dan kode kesalahan. Tidak ada frame, tidak ada
koordinat landmark. Endpoint menolak payload apa pun yang mengandung data pose
**sebelum** sampai ke model — pertahanan berlapis, karena klien memang tidak
bisa menyusun payload seperti itu dari tipe `SetSummary`.

**Mengapa ini loop terpisah, bukan rule yang lebih besar.** Fast loop bisa
bilang "turunkan dada lebih dalam" saat repetisi sedang berlangsung. Yang tidak
bisa ia lakukan adalah melihat satu set utuh, menyadari fase turun melambat 400
ms di paruh kedua, lalu memutuskan bahwa itu lebih penting daripada kedalaman
kali ini. Penilaian atas konteks agregat itulah alasan model ada di sini.

**Mengapa tidak streaming.** Rencana awal menyebut streaming supaya TTS bisa
mulai lebih awal. Itu keliru: keluarannya JSON terstruktur, dan JSON separuh
jadi tidak bisa dibacakan — TTS tetap harus menunggu teks utuh. Streaming hanya
menambah kerumitan parsing untuk keuntungan yang tidak bisa dipakai.

Setiap respons membawa `usage` dan `latencyMs`, ditampilkan di bawah narasi.
Angka biaya dan latensi yang masuk paper diambil dari trafik nyata, bukan
estimasi.

**Jalur kegagalan** (semuanya menurunkan kualitas, tidak mematikan latihan):
offline dan timeout 15 detik dilewati dengan pesan; kunci belum diset
menghasilkan instruksi konkret; set nol repetisi dijawab langsung tanpa
memanggil model sama sekali.

---

## Suara — dua jalur, dua kendala berbeda

**Cue koreksi: MP3 pra-render.** Himpunan frasa koreksi tertutup — tujuh kalimat,
terdaftar di `CUE_TEXT` pada `core/rules.ts`. Semuanya dibangkitkan jadi MP3
saat build oleh `scripts/gen-cues.mjs`, lalu diputar tanpa jaringan sama sekali.

Alasannya: cue yang datang satu detik terlambat **bukan cue yang telat, tapi cue
yang salah** — repetisi yang dibicarakannya sudah lewat. Memanggil TTS di
tengah set juga berbiaya tiap repetisi dan langsung bisu saat WiFi lokasi lomba
bermasalah.

Nama berkasnya mengandung hash dari teksnya. Mengedit sebuah frasa menghasilkan
nama baru, sehingga rekaman lama berhenti dirujuk — bukan diam-diam terputar
mengucapkan koreksi yang sudah tidak berlaku.

**Narasi antar-set: TTS runtime.** Teksnya ditulis ulang oleh pelatih AI setiap
set, jadi tidak bisa dipra-render. Ini diputar saat pengguna beristirahat, di
mana latensi ~3 detik tidak berbiaya apa-apa.

**Cadangan:** kalau `/api/tts` gagal — offline, kunci belum diset, kuota habis —
sistem jatuh ke `speechSynthesis` bawaan browser dengan voice `id-ID`. Kualitas
lebih rendah, tapi demo yang bisu lebih buruk daripada suara yang lebih polos.

Regenerasi manual: `npm run gen:cues` (idempoten, melewati yang sudah ada).
Tanpa `OPENAI_API_KEY` skrip ini memberi peringatan dan berhenti tanpa
menggagalkan build — teman tim tetap bisa bekerja dengan suara cadangan.

---

## Alat anotasi

Buka **http://localhost:5174/annotate.html** setelah `npm run dev`.

Alur: pilih video → ekstrak keypoint → periksa segmentasi repetisi → beri label
kelas kesalahan → unduh JSON.

**Mengapa ekstraksi dilakukan di browser, bukan lewat Python.** Alat ini
memakai `PoseSource` dan `RepCounter` yang **sama persis** dengan aplikasi.
MediaPipe Python dan MediaPipe JS adalah jalur implementasi berbeda meski bobot
modelnya sama; perbedaan numerik sekecil apa pun membuat angka evaluasi
menggambarkan harness, bukan produk. Dengan cara ini paritas itu mutlak dan
gratis. Pelatihan tetap di Python — JSON hasil ekspor adalah antarmukanya.

**Dua aturan yang menjaga dataset tetap sahih:**

1. **Label rule tidak pernah dicentang otomatis.** Dugaan dari `rules.ts`
   ditampilkan sebagai petunjuk di kolom terpisah (`suggested`), tidak pernah
   disalin ke `labels`. Kalau dataset diunggulkan dari keluaran rule,
   classifier hanya belajar meniru rule — dan ablation *rule-only* vs
   *rule+classifier* menjadi membandingkan sesuatu dengan salinannya sendiri.
2. **Subject ID wajib diisi.** Pemisahan train/test harus per orang. Kalau
   repetisi dari orang yang sama bocor ke kedua sisi, F1 akan terlihat bagus
   secara palsu — dan penguji yang teliti akan menemukannya.

Ekspor ditolak jika hitungan tersegmentasi tidak cocok dengan hitungan manual,
deteksi pose di bawah 60%, atau Subject ID kosong. Selisih antara hitungan
manual dan hitungan otomatis **adalah** data akurasi rep-count, jadi hitung
sendiri dari video — jangan menyalin angka segmentasi.

---

## Evaluasi

```bash
node --experimental-strip-types eval/eval_reps.mjs
```

Flag itu diperlukan di Node 22; sejak Node 23.6 sudah aktif secara bawaan.

Tanpa data terekam, skrip menjalankan **self-check sintetis** dan menandai
hasilnya sebagai bukan angka akurasi — supaya angka sintetis tidak pernah
tersalin ke paper sebagai hasil pengukuran. Setelah anotasi tersedia:

```bash
node --experimental-strip-types eval/eval_reps.mjs --input eval/data
```

Hasil ditulis ke `eval/results/rep_accuracy.json`.

---

## Dua keputusan desain yang perlu diketahui sebelum mengubah kode

### 1. Gate counter harus lebih longgar daripada ambang rule

Penghitung repetisi menghitung **percobaan**; rules menilai **kualitasnya**.
Rules hanya melihat repetisi yang berhasil dihitung counter.

Kalau `downEnter` (gate counter) disamakan dengan `depthMax` (ambang rule),
setiap repetisi yang terhitung otomatis lolos ambang — dan rule `shallow_depth`
menjadi kode mati yang tetap terlihat benar saat dibaca sendirian. Bug ini
pernah terjadi dan lolos unit test, karena tes membangun window sintetis yang
bisa memuat sudut apa pun.

`rules.test.ts` sekarang memeriksa relasi ini langsung terhadap
`DEFAULT_CONFIGS`. Jangan longgarkan ambang rule tanpa memeriksa gate counter.

### 2. Sudut dihitung dari world landmarks, bukan koordinat gambar

MediaPipe mengembalikan dua set koordinat. `landmarks` dinormalisasi ke [0,1]
**secara terpisah** untuk lebar dan tinggi — sehingga langkah yang sama pada x
dan y bukan jarak fisik yang sama. Menghitung sudut dari sana menghasilkan nilai
yang salah, dan besar kesalahannya berubah mengikuti rasio aspek kamera.

`worldLandmarks` bersifat metrik dan bebas distorsi itu. Koordinat gambar hanya
dipakai untuk menggambar overlay.

---

## Klaim privasi — cara memverifikasinya sendiri

Frame kamera tidak pernah meninggalkan perangkat. Ini ditegakkan oleh kode,
bukan janji:

1. Jalankan aplikasi, lakukan satu set, buka **DevTools → Network**. Tidak ada
   request yang membawa gambar.
2. Di Console, jalankan `latih.summarizeCurrentSet()` — itulah **satu-satunya**
   objek yang akan dikirim keluar. Isinya hanya sudut, durasi, dan kode error.
3. `assertNoRawPoseData()` di `core/setSummary.ts` menolak payload yang
   mengandung `landmark`, `image`, `frame`, atau `base64`. Ada unit test yang
   sengaja menyelundupkan koordinat dan memastikan fungsi itu melempar error.
4. Matikan koneksi internet — penghitung repetisi dan cue tetap berjalan penuh.

Sebelum deploy, pastikan tidak ada kunci API yang bocor ke bundle:

```bash
npm run build
grep -r "sk-" dist/        # harus kosong
```

---

## Model & dataset

Pose estimation memakai **MediaPipe Pose Landmarker (BlazePose)** dari Google —
diunduh otomatis oleh `setup:assets`, bukan model latihan kami.

Klasifier form yang kami latih sendiri beserta datasetnya akan dipublikasikan di
Hugging Face dan ditautkan di sini setelah pelatihan selesai.

---

## Lisensi

Belum ditentukan. Kode ini dibuat untuk penjurian Datathon 2026.
