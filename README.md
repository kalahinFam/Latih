# LATIH — Pelatih Pribadi AI

Pelatih kebugaran berbasis AI yang berjalan di browser ponsel. Mengamati latihan
lewat kamera, menghitung repetisi, dan mengoreksi form secara real-time —
**seluruh pemrosesan citra terjadi di perangkat.**

Datathon 2026, Ristek Fasilkom UI — University Track. Tim **Kalahin Fam**,
Universitas Indonesia.

---

## Status saat ini

Ketiga loop sudah berjalan: fast loop di perangkat (kamera → pose estimation →
sudut sendi → penghitung repetisi → koreksi form), slow loop (narasi LLM per
set), dan session loop (adaptasi target dari riwayat latihan).

| Komponen | Status |
|---|---|
| Pose estimation on-device (MediaPipe) | ✅ berjalan |
| Penghitung repetisi (push-up, squat) | ✅ berjalan |
| Plank — durasi + garis pinggul | ✅ berjalan |
| Onboarding tujuh layar | ✅ berjalan |
| Koreksi form deterministik + cue | ✅ berjalan |
| Instrumentasi latensi & FPS | ✅ berjalan |
| PWA installable + offline | ✅ berjalan |
| Ekstraksi fitur per repetisi | ✅ berjalan |
| Harness evaluasi rep-count | ✅ berjalan |
| Alat anotasi (video → keypoint berlabel) | ✅ berjalan |
| Slow loop (narasi LLM per set) | ✅ berjalan |
| TTS Bahasa Indonesia (cue + narasi) | ✅ berjalan |
| Nutrisi TKPI + verifier grounding | ✅ berjalan, 1.133 bahan pangan |
| Session loop (adaptasi target dari riwayat) | ✅ berjalan |
| Rencana latihan mingguan | ✅ berjalan |
| Target kalori + saran menu dari TKPI | ✅ berjalan |
| Pengingat jam latihan (Web Push) | ✅ berjalan, butuh kunci VAPID |
| Klasifier form (ONNX) | ⬜ tidak dikerjakan (lihat di bawah) |

**Soal klasifier form.** Arsitektur yang diklaim paper untuk fast loop adalah
sudut sendi → rule deterministik + state machine, dan itulah yang berjalan.
Klasifier terlatih adalah gagasan tambahan dari rencana implementasi, bukan
klaim paper, jadi tidak mengerjakannya tidak meninggalkan klaim tanpa kode.
`core/features.ts` (window per rep → tensor 32×12) tetap ada sebagai jalur
masuknya kalau nanti dikerjakan.

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

Buka **http://localhost:5174** (atau port yang ditampilkan), tekan **Mulai
latihan**, pilih gerakan, lalu izinkan akses kamera.

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
| `npm test` | Unit test (450 tes) |
| `npm run gen:vapid` | Membangkitkan sepasang kunci Web Push |
| `npm run tts:lab` | Contoh suara pelatih untuk dibandingkan (folder `tts-lab/`) |
| `npm run gen:cues -- --force` | Membangkitkan ulang klip cue setelah ganti suara |
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
│  FAST LOOP (TypeScript murni, tanpa DOM) — dalam repetisi               │
│    sudut sendi → state machine rep-count → pemeriksaan form → cue       │
│      ↓ per set selesai: JSON statistik agregat                          │
│                                                                         │
│  SESSION LOOP — antar sesi                                              │
│    localStorage riwayat → target repetisi berikutnya + tren             │
│    → rencana mingguan (hari, gerakan, set × repetisi)                   │
│                                                                         │
│  Profil tubuh → Mifflin-St Jeor → target kalori harian                  │
│    (riwayat & ukuran tubuh tidak pernah diunggah;                       │
│     yang keluar hanya angka turunannya)                                 │
└────────────────────────────┬────────────────────────────────────────────┘
                             │  angka saja — tanpa frame, tanpa koordinat,
                             │  tanpa berat/tinggi/usia
                    ┌────────▼─────────────────────┐
                    │  SLOW LOOP  /api/coach       │  narasi per set
                    │  NUTRISI    /api/nutrition   │  TKPI + verifier
                    │  MENU       /api/meals       │  opsi menu, total di kode
                    │  SUARA      /api/tts         │  narasi → audio
                    │  PENGINGAT  /api/push        │  langganan Web Push
                    └────────────────────────────┬─┘
                                                 │  cron tiap 15 menit
                                    ┌────────────▼──────────────┐
                                    │  /api/cron-reminders      │
                                    │  push tanpa payload →     │
                                    │  teks disusun di device   │
                                    └───────────────────────────┘
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
│   ├── sessionLoop.ts  adaptasi target dari riwayat antar-sesi
│   ├── plan.ts         rencana mingguan dari target + preferensi
│   ├── energy.ts       Mifflin-St Jeor → target kalori & protein
│   ├── pantry.ts       bahan pangan terkurasi, per kode TKPI
│   ├── meals.ts        validasi opsi menu + perhitungan total
│   ├── metrics.ts      instrumentasi FPS & latensi
│   └── quality.ts      skor kualitas, runtutan hari, agregat sesi
├── app/           ← router hash + state sesi latihan
├── session/       ← penyimpanan di perangkat: riwayat, profil, pengingat
├── pose/          ← satu-satunya file yang tahu MediaPipe ada
└── ui/
    ├── workoutEngine.ts  fast loop + kamera, dua mode
    ├── skeleton.ts       overlay
    ├── icons.ts          tujuh ikon, digambar sendiri
    └── screens/          satu modul per layar

web/test/          ← tes integrasi terhadap data & kode server nyata.
                     Di luar src/ supaya src/ tetap murni kode browser.
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

Tekan **STOP** (tombol merah di pojok kanan bawah) setelah selesai. Klien mengirim ringkasan set ke
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

**Perbandingan angka dikerjakan di kode, bukan diserahkan ke model.**
`directivesFor()` mengevaluasi setiap ambang lalu menyuntikkan baris
`INSTRUKSI:` tanpa syarat. Alasannya empiris: diberi angka mentah, model
mengarang kekurangan pada set tanpa cacat, mengabaikan `trackingQuality` yang
rendah setelah membandingkannya sendiri, mengubah "naik 2 repetisi" menjadi "dua
kali lipat", dan memuji "kemajuan" pada sesi yang justru kehilangan 4 repetisi
dan 9° kedalaman. Semuanya kesalahan yang sama: meminta model mengevaluasi
ambang numerik dan mengingat sebuah kondisional. Yang sampai ke model sekarang
adalah instruksi tanpa syarat yang tinggal dipatuhi.

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

## Session loop — target yang menyesuaikan diri

Loop ketiga dan paling lambat. Fast loop bereaksi di dalam satu repetisi, slow
loop merenungi satu set, session loop melihat lintas sesi dan menentukan apa
yang diminta berikutnya. `core/sessionLoop.ts` (logika murni, tanpa DOM) +
`session/history.ts` (penyimpanan).

**Riwayat tidak pernah meninggalkan perangkat.** Disimpan di `localStorage`,
maksimal 500 set. Yang ikut ke `/api/coach` hanya angka turunannya — target,
selisih repetisi, selisih kedalaman — bukan lognya. Konsisten dengan klaim yang
sama untuk frame kamera.

**Tiga aturan yang membentuknya, dan alasannya:**

- **Kualitas menjadi syarat kenaikan, bukan hanya jumlah.** Aturan naif "kemarin
  dapat lebih banyak, naikkan target" melatih orang mengejar angka dengan
  memangkas kedalaman — persis kesalahan yang dibangun fast loop untuk
  menangkapnya. Kalau repetisi tercapai tapi >25% rep kena flag, target ditahan
  dan narasi diarahkan ke form.
- **Butuh dua sesi berturut-turut.** Satu sesi bagus itu derau — hari yang segar,
  sudut kamera yang kebetulan lebih baik. Naik setiap kali ada satu sesi bagus
  menghasilkan target yang memanjat lebih cepat daripada adaptasi tubuh, lalu
  serentetan kegagalan.
- **Dinilai dari set terbaik sesi itu, bukan set terakhir.** Kelelahan membuat
  set belakangan selalu lebih rendah; menilai dari yang terakhir akan membaca
  setiap latihan normal sebagai kemunduran.

Sesi dengan `trackingQuality` di bawah 0.7 **dilewati sepenuhnya**, tidak
dihitung sebagai kegagalan — yang bermasalah kameranya, bukan orangnya. Ini
alasan yang sama dengan menahan hitungan repetisi saat confidence rendah:
menghukum orang atas kesalahan sensor merusak kepercayaan lebih cepat daripada
kehilangan satu sesi data.

Target tampil di HUD selama set berjalan, bukan hanya di ringkasan sesudahnya —
target yang baru diberitahu setelah selesai itu skor, target yang terlihat sambil
bekerja itu yang mengubah perilaku.

---

## Alur aplikasi

Sepuluh layar dalam satu dokumen, dengan router hash di `app/router.ts`:

```
Pembuka ──► Onboarding (6 langkah) ──┐
                                     ▼
Beranda ──► Pilih gerakan ──► Posisi kamera ──► Latihan ──► Umpan balik set
   ▲                                              ▲              │
   │                                              └── set lagi ───┤
   └──────────────── Ringkasan sesi ◄─────── selesai ─────────────┘

Nav bawah: Latihan · Riwayat · Gizi          Pengaturan dari Beranda
```

**Kenapa satu dokumen, bukan beberapa halaman.** Kamera harus bertahan
melintasi setiap transisi itu. Halaman terpisah membongkar dokumen setiap kali
berpindah, artinya membongkar `getUserMedia` dan menginisialisasi ulang
MediaPipe — layar hitam beberapa detik, di tengah latihan, tepat saat
penggunanya sudah telentang di lantai menunggu. Elemen `<video>` hidup di
lapisan tersendiri di luar layar-layar itu dan tidak pernah dipindahkan.

**Kenapa hash, bukan History API.** Aplikasinya disajikan sebagai berkas
statis, dan tautan dalam harus tetap terbuka tanpa rewrite di sisi server.

### Onboarding — hanya menanyakan yang dipakai menghitung

Setiap pertanyaan ada karena ada yang menghitung dengan jawabannya. Nama untuk
sapaan; usia, jenis kelamin, tinggi, dan berat untuk Mifflin-St Jeor; aktivitas
untuk pengalinya; tujuan untuk arah penyesuaian kalori; pengalaman untuk target
repetisi sesi pertama; pantangan untuk menyaring baris TKPI.

Pertanyaan tanpa konsumen adalah pertanyaan yang membuang waktu pengguna lalu
mengendap di penyimpanan menyerupai fitur. Kalau sebuah jawaban berhenti dibaca,
hapus pertanyaannya.

**Layar penutup menunjukkan hitungannya, bukan ucapan selamat** — BMR, pengali
aktivitas, penyesuaian, hasil, lalu target repetisi pertama beserta asalnya.
Itu hanya layak dilakukan kalau angkanya nyata, jadi seluruhnya dihitung dari
`core/energy.ts` dan `core/onboarding.ts` saat dirender; tidak ada satu pun yang
ditulis di markup. Ringkasan yang harus disinkronkan manual adalah ringkasan
yang cepat atau lambat akan berbohong.

**Janji pantangan ditegakkan, bukan diminta.** Layarnya berkata *"bahan yang
dipilih tidak akan muncul di menu mana pun"*. Baris yang dikecualikan dihapus
dari pantry **sebelum** prompt dibangun, jadi tidak ada yang bisa dilanggar
model — dan validasi di `core/meals.ts` memakai pantry tersaring yang sama, jadi
kode terlarang yang tetap dikarang tetap ditolak. Diuji ke endpoint hidup: tanpa
pantangan model memakai ayam dan udang; dengan pantangan, **nol pelanggaran dari
tiga skenario**.

Yang dikirim adalah **kode bahannya, bukan pantangannya**: "tidak makan seafood"
itu fakta tentang orangnya, daftar kode makanan itu fakta tentang menunya. Hanya
yang kedua perlu meninggalkan ponsel.

### Layar posisi kamera — centang hanya untuk yang diukur

Desain menampilkan empat pemeriksaan. Aplikasi benar-benar mengukur dua: badan
utuh di frame, dan jarak secara kasar lewat `bodyFill` — porsi tinggi layar yang
ditempati badan.

Sudut kamera dan tinggi kamera **tidak diukur sama sekali**; tidak ada apa pun
di pipeline yang memperkirakan keduanya. Jadi dua baris itu ditampilkan sebagai
panduan tertulis tanpa centang. Centang berarti *aplikasi memeriksa ini*, dan
centang yang artinya "kami asumsikan begitu" akan membuat dua centang lainnya
tidak berarti. Juri yang bertanya bagaimana pemeriksaan 30–45° bekerja pantas
mendapat jawaban yang lebih baik daripada lingkaran hijau.

Jaraknya pun dinyatakan dalam porsi tinggi layar, bukan meter: konversi ke meter
butuh field of view lensa dan tinggi badan penggunanya, dan aplikasi tidak punya
keduanya.

### Plank — mesin tersendiri, bukan counter dengan timer

Repetisi adalah **peristiwa**: satu ambang dilewati dua kali berurutan. Tahanan
tidak punya peristiwa sama sekali — ia **keadaan** yang sedang dipertahankan
atau tidak, dan satu-satunya besaran adalah berapa lama. `core/holdTracker.ts`.

**Jam hanya berjalan selama plank-nya nyata.** Waktu ketika pinggul sudah ambruk
bukan waktu plank. Mengkreditkannya akan membuat tiga puluh detik yang melorot
tak bisa dibedakan dari tiga puluh detik yang tertahan — kesalahan yang sama
dengan mengkreditkan setengah repetisi, dan kode ini sudah memutuskan soal itu.

Jadi putusnya garis **menghentikan jam, bukan mengakhiri set**. Angkanya berhenti
dan layar jadi amber, yang mengatakan *kenapa* tanpa teks sama sekali, dan
lanjut lagi begitu garisnya lurus.

**Ada grace, karena plank bukan foto.** Garis pinggul bergoyang terus saat lelah;
tidak ada satu frame di mana ia "putus". Turun sesaat yang langsung dikoreksi
sendiri adalah bagian dari menahan plank, bukan kegagalan menahannya — jadi
putusnya harus bertahan 300 ms sebelum jam berhenti.

**Kameranya beda.** Push-up dan squat minta serong 30–45°; plank minta **samping
penuh**. Yang dinilai cuma satu garis, dan garis paling sulit dibaca dari arah ia
menunjuk.

Skor kualitas untuk plank adalah porsi set yang benar-benar dipakai menahan
posisi — gagasan yang sama dengan skor repetisi, dalam satuan gerakannya
sendiri.

---

## Layar latihan — tiga aturan dari desain

Mengikuti opsi **1b** dari dokumen desain. Batasannya: dibaca dari ±2 m, dari
ketinggian lantai, sambil badan bergerak. Tiga konsekuensinya, dan semuanya
terlihat di `style.css`:

- **Satu angka besar, sisanya kecil dan di tepi.** Tidak ada elemen lain yang
  minta dibaca dengan tenang.
- **Angkanya sendiri yang berubah warna.** Sage berarti form benar, amber
  berarti ada koreksi. Sinyal dan benda yang dilihat adalah objek yang sama,
  jadi mengetahui status tidak memerlukan perpindahan pandangan. Skeleton
  dibiarkan putih justru karena itu — kalau ikut berwarna, layar mengatakan hal
  yang sama dua kali, dan sorot amber di sendi kehilangan artinya sebagai
  penunjuk **di mana** masalahnya.
- **Angka ditaruh di sepertiga bawah.** Dari lantai, sambil push-up, arah
  pandang jatuh ke bawah layar, bukan ke tengah.

Kemajuan set ditampilkan sebagai deret strip di tepi kanan — terbaca lewat
panjang, tanpa satu pun angka tambahan. Koreksi menggantikan kapsi di bawah
angka, tidak muncul di sebelahnya: pada jarak itu dua baris teks sudah satu
baris terlalu banyak.

---

## Rencana mingguan

Layar Beranda dan Pengaturan. Session loop memutuskan **berapa repetisi**; ini
memutuskan **kapan menagihnya**, dan mengubah satu angka di HUD menjadi sesuatu
yang berbentuk rencana.

**Satu sumbu progresi.** Set tetap, hanya target repetisi yang bergerak.
Menaikkan set dan repetisi sekaligus membuat beban berubah tak terduga — dua
sesi bisa berbeda 30% total volume tanpa satu angka pun terlihat ganjil — dan
membuat adaptasinya tidak bisa dijelaskan ke pengguna dalam satu kalimat.
Repetisi adalah sumbu yang benar-benar diukur fast loop, jadi repetisi yang
bergerak.

**Hari disebar, bukan digumpalkan.** Tiga sesi di Jumat–Sabtu–Minggu secara
nominal sama frekuensinya dengan Senin–Rabu–Jumat, dan nyatanya minggu yang
jauh lebih buruk: pemulihan terjadi di antara sesi, bukan menumpuk di akhir.

---

## Target kalori — persamaan, bukan tebakan model

`core/energy.ts`, Mifflin-St Jeor (1990), dihitung **di perangkat**. Ukuran
tubuh tidak pernah dikirim ke mana pun; yang keluar hanya anggaran kalori per
waktu makan. `MealsRequest` memang tidak punya tempat untuk berat atau usia —
cara yang sama dengan `SetSummary` yang tidak punya tempat untuk frame video.

Tiga hal yang membuatnya bisa dipertanggungjawabkan:

- **Rentang, bukan satu angka.** Persamaan ini akurat dalam 10% untuk sekitar
  70% orang. Menampilkan "2.340 kkal" tanpa rentang mengklaim presisi yang tidak
  dimiliki persamaannya.
- **Dua batas bawah.** App tidak akan pernah menyarankan asupan di bawah
  metabolisme basal, kombinasi input apa pun yang diketik pengguna. Di situlah
  target penurunan berat berhenti jadi diet.
- **Input di luar rentang ditolak, bukan diekstrapolasi.** Di luar rentang itu
  persamaannya tidak pernah divalidasi, dan angka yang tetap dikeluarkan akan
  terlihat sama meyakinkannya dengan angka yang benar.

---

## Saran menu — di mana verifier lama tidak cukup

Ini kasus yang tidak bisa ditangkap verifier grounding yang sudah ada. Verifier
itu memeriksa apakah sebuah angka **muncul** di baris hasil retrieval. Total
sebuah menu tidak muncul di baris mana pun, karena ia **turunan** — dan total
yang salah, dirakit dari bahan-bahan yang setiap angkanya asli dari TKPI, akan
lolos.

Jadi pembagian kerjanya digeser: **model memilih bahan dan porsi**, dan setiap
angka setelah itu dihitung di `core/meals.ts` dari baris TKPI yang kodenya
merujuk.

**Retrieval per kata kunci juga salah tempat di sini.** Tidak ada pertanyaan
untuk dicari, dan mencari "ayam" di tabel mengembalikan ayam goreng tiga
jaringan restoran sebelum sampai ke ayam biasa, sementara "tempe" tidak
mengembalikan apa pun selain keripik. Perencana menu yang dibangun di atas itu
akan diam-diam menyarankan makanan ringan. Pantry-nya dikurasi **per kode
TKPI**, dan ada tes yang memastikan setiap kode merujuk ke baris nyata yang
tidak ditandai `suspect` — salah ketik satu kode menggagalkan build, bukan
menyusutkan menu tanpa ketahuan.

**Yang terukur.** Diuji ke `gpt-4o-mini` atas dua belas waktu makan: lima opsi
ditolak karena totalnya meleset, **selalu karena kurang**, dan melesetnya
membesar seiring target. Satu opsi lain mengarang kode TKPI yang tidak ada —
ditangkap pemeriksaan pantry. Menambahkan petunjuk aritmetika di prompt dan
meminta opsi keempat menurunkan penolakan dari **42% ke 29%**. Sisanya adalah
ongkos jujur meminta model bahasa memenuhi kendala aritmetika; ia diserap, bukan
disembunyikan — yang sampai ke pengguna hanya yang lolos validasi.

---

## Pengingat jam latihan

Web Push sungguhan: server membangunkan service worker pada jam yang dipilih,
terlepas dari apakah aplikasinya sedang dibuka. Pengingat yang hanya berbunyi
saat aplikasi terbuka bukan pengingat.

**Push tanpa payload.** Server mengirim bangunan kosong; teksnya disusun di
service worker, di perangkat. Layanan push — Google atau Mozilla, tergantung
browser — merelai notifikasi yang isinya tidak pernah ia lihat. Ini juga yang
membuat VAPID bisa ditulis sendiri tanpa dependensi: yang tersisa cuma JWT
ES256, dan Node menandatanganinya secara native dengan `dsaEncoding:
'ieee-p1363'` — format mentah yang diminta JWS, tanpa perlu membongkar DER.
Paket `web-push` sebagian besar ada untuk mengenkripsi payload, yang di sini
tidak dipakai.

**Yang dibutuhkan sebelum ini hidup:**

```bash
npm run gen:vapid          # → VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
```

Isikan keduanya ke `.env` dan ke Environment Variables di Vercel. Tanpa itu,
tombol pengingat otomatis disembunyikan dan sisa aplikasi berjalan normal.

**Penyimpanan langganan.** Serverless tidak punya state, jadi langganan disimpan
di Upstash Redis lewat REST API-nya dengan `fetch` biasa — tanpa SDK tambahan.
Kalau `UPSTASH_REDIS_REST_URL` belum diisi, penyimpanan jatuh ke memori: cukup
untuk mencoba di lokal, hilang setiap kali server di-deploy ulang, dan halaman
Rencana mengatakannya apa adanya.

**Batasnya, dinyatakan di UI bukan disembunyikan.** Di iPhone, push hanya sampai
ke PWA yang sudah ditambahkan ke Layar Utama — tidak pernah ke tab biasa.
`reminderSupport()` melaporkan alasannya, karena memberi tahu itu lebih berguna
daripada tombol yang diam-diam tidak melakukan apa-apa. Zona waktu dikirim
sebagai offset UTC, bukan nama zona: tepat untuk Indonesia yang tidak memakai
DST, dan bisa meleset satu jam di tempat yang memakainya sampai klien
mendaftar ulang.

---

## Nutrisi TKPI — grounding yang bisa diperiksa, bukan diklaim

**1.144 bahan pangan**, diekstrak otomatis dari
[panganku.org](https://www.panganku.org/id-ID/view) — basis data resmi TKPI.
1.133 bisa disitir; 11 dikecualikan karena angkanya tidak konsisten **di
sumbernya sendiri** (lihat [`data/tkpi/README.md`](data/tkpi/README.md)).

Ketik pertanyaan di panel **Tanya gizi**. Jawabannya muncul **beserta baris
TKPI yang dipakai**, lengkap dengan angka dan sumbernya, supaya siapa pun —
termasuk juri — bisa mencocokkannya sendiri tanpa meninggalkan halaman.

**Alur, dan kenapa tiap langkahnya ada:**

1. **Retrieval** mencari bahan yang disebut pertanyaan. Kalau tidak ada yang
   cocok, model **tidak dipanggil sama sekali** — tanpa baris data, tidak ada
   yang bisa menjadi dasar jawaban, dan bertanya tetap adalah persis cara
   sebuah angka karangan diproduksi.
2. **Model hanya menerima baris hasil retrieval**, dengan larangan eksplisit
   menghitung, mengalikan, atau memakai pengetahuannya sendiri.
3. **Verifier memeriksa setiap angka** di jawaban terhadap baris tersebut.
4. **Gagal → tulis ulang sekali** dengan instruksi lebih ketat.
5. **Gagal lagi → narasi dibuang**, tabel mentah tetap ditampilkan.

Langkah terakhir itu intinya. Asisten gizi yang sesekali mengarang angka masuk
akal lebih buruk daripada yang kadang menolak menulis prosa, karena pengguna
tidak bisa membedakan keduanya. Menolak adalah kegagalan yang jujur.

**Yang diperiksa hanya angka berunit.** Klaim gizi selalu punya satuan —
"20,8 gram protein", "201 kkal". Angka telanjang adalah hitungan dan urutan
("dua bahan"), bukan klaim komposisi. Memeriksanya juga akan menolak jawaban
benar karena menyebut "dua", dan tim akan mematikan verifier-nya.

Angka Indonesia dibaca sesuai konvensinya: koma desimal, titik ribuan. Membaca
"20,8" ala Inggris menghasilkan 208 dan membuat setiap pemeriksaan gagal.

### Mengukurnya

```bash
npm run dev                    # di terminal lain
npm run eval:grounding
```

Baterainya sengaja memuat pertanyaan yang **memancing** model mengarang: bahan
yang tidak ada di tabel, aritmetika yang dilarang, dan klaim kesehatan. Skor
grounding yang hanya diukur pada pertanyaan mudah tidak berarti apa-apa.

Hasil pada tabel penuh 1.133 baris — 12 pertanyaan, 35 angka diperiksa:

| Metrik | Hasil |
|---|---|
| Jawaban ter-grounding | **100%** |
| Perlu tulis ulang | 0% |
| Narasi ditahan | 0% |
| Bahan tak tersedia ditangani tanpa mengarang | **100%** |
| Sitiran nyasar | **0** |
| Latensi median | 1.492 ms |

### Retrieval memakai kekhasan kata, bukan sekadar kecocokan

Ini muncul dari pengukuran, bukan dari desain awal. Pada tabel 10 baris semua
metrik hijau; begitu tabel penuh masuk, pertanyaan *"berapa protein daging
unta"* menyitir empat baris daging — karena "daging" cocok dengan ratusan nama
sementara "unta" tidak cocok dengan apa pun. Jawabannya tetap benar ("data
tidak tersedia"), tapi empat bahan tak relevan tampil sebagai sumbernya.

Perbaikannya: sebuah kecocokan hanya diterima kalau setidaknya satu kata yang
cocok **cukup khas** — muncul di ≤3% nama pangan, dengan batas absolut agar
aturan ini tetap berlaku di tabel kecil.

Percobaan pertama saya salah: mensyaratkan kecocokan menjelaskan sebagian besar
pertanyaan. Aturan itu menolak *"tempe tahu telur ayam"* mentah-mentah — empat
bahan disebut, jadi tidak ada satu baris pun yang bisa menjelaskan mayoritasnya.

### Validasi data

```bash
npm run check:tkpi
```

Memeriksa kode duplikat, basis bukan 100 g, dan konsistensi Atwater
(protein×4 + karbo×4 + lemak×9 ≈ energi).

Pemeriksaan ini menemukan **11 baris (0,96%) yang angkanya bertentangan dengan
dirinya sendiri di data resmi TKPI** — sudah dicocokkan langsung ke halaman
sumber. Baris itu disimpan demi provenance, ditandai `suspect`, dan
dikecualikan dari retrieval. Sistem yang grounded pada sumber eksternal tetap
harus memvalidasi sumbernya; itu temuan yang layak masuk subbagian Responsible
AI.

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

### Kalau suaranya terdengar kaku

Tiga kemungkinan, dan yang pertama paling sering.

**1. Yang terdengar bukan suara OpenAI.** Kalau klip cue gagal diputar, atau
`/api/tts` tidak bisa dihubungi, playback jatuh ke `speechSynthesis` bawaan
browser — dan di Android suara `id-ID` bawaan memang jauh lebih sintetis.
Gejalanya identik dengan "suaranya robotik", padahal sebabnya suara yang kita
buat tidak pernah diputar. Cek langsung di konsol perangkat:

```js
latih.engine.audioSource   // 'clip' | 'server' | 'browser' | null
```

`'browser'` berarti kamu sedang mendengar cadangan, bukan pelatihnya.

**2. Arahannya kurang spesifik.** `gpt-4o-mini-tts` bisa diarahkan, tapi arahan
pendek hampir tidak mengarahkan apa pun — "hangat dan jelas" meninggalkannya
pada suara baca-nyaring bawaannya, dan itulah yang orang sebut robotik. Yang
menggerakkannya adalah mendeskripsikan **pertunjukannya**: siapa yang bicara,
kepada siapa, sedekat apa, di mana nadanya naik-turun, di mana napasnya. Lihat
`api/_voice.ts`.

**3. Suaranya memang tidak cocok.** Ini keputusan telinga, bukan keputusan yang
bisa diambil dari deskripsi. `npm run tts:lab` merender kalimat yang sama di
beberapa suara × beberapa gaya ke folder `tts-lab/`; dengarkan, lalu isi
`TTS_VOICE` dan `TTS_STYLE` di `.env`.

Satu jebakan: nama berkas klip di-hash dari **frasanya**, bukan dari suaranya.
Ganti suara tanpa `--force` dan narasi akan berubah sementara cue tetap memakai
suara lama — dua pelatih dalam satu sesi.

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

## Enam keputusan desain yang perlu diketahui sebelum mengubah kode

### 0. Jangan rata-ratakan sisi kiri dan kanan begitu saja

`reliableMean` di `core/angles.ts`, dan ini perbaikan terpenting yang lahir dari
uji lapangan.

MediaPipe **tidak menghilangkan** anggota badan yang tertutup — ia menebaknya,
dan melaporkan visibility yang tetap di atas ambang mana pun yang masuk akal
dipasang. Merata-ratakan tebakan itu dengan pembacaan yang bagus menghasilkan
angka yang lebih buruk daripada keduanya.

Ongkosnya nyata dan terukur. Dari sudut serong, push-up di posisi bawah
menyembunyikan lengan jauh di balik badan, dan MediaPipe cenderung menebaknya
hampir lurus. Siku dekat terbaca ~95°, yang jauh ~170°, rata-ratanya ~132° —
tepat di bawah gate 135 pada frame bagus dan di atasnya pada frame jelek.
Hasilnya penghitung yang bekerja selama lengan terbuka dan berhenti persis saat
gerakannya jadi berarti: dilaporkan sebagai push-up "hampir gapernah" terhitung,
sementara lambaian tangan acak terhitung mulus.

Mekanisme yang sama membuat squat terbaca lebih dalam daripada nyatanya, jadi
rep separuh lolos ambang kedalaman dan penggunanya malah disuruh berdiri lebih
tegak alih-alih turun lebih dalam.

Rata-rata tetap dipakai kalau kedua sisi sama-sama terlihat baik — di situ ia
memang meredam jitter. Di luar itu, ambil sisi yang terlihat.

### 0b. Sudut sendi tidak bisa menjawab "apakah gerakan ini sedang terjadi"

`core/posture.ts`. Lutut yang menekuk lalu lurus terbaca identik entah orangnya
berdiri atau berbaring — dilaporkan sebagai "kayak knee crunch dihitung asal
kaki ditekuk trus dilurusin". Yang membedakan adalah orientasi badan, dan itu
tidak ada di sudut sendi.

Ambangnya sengaja jauh lebih longgar daripada form yang baik. Ini **bukan** rule
form dan tidak boleh menolak repetisi nyata: squat dalam mencondongkan badan
jauh ke depan, dan push-up dari sudut serong tidak seterbaca "datar". Yang
ditolak hanya kasus yang tidak ambigu — orang berbaring, duduk, atau berdiri
diam. Kalau tidak bisa memastikan, ia mengizinkan.

### 0d. Setengah rep dilihat, tapi tidak dihitung

Counter punya **dua** ambang. `downEnter` menjawab "apakah ada percobaan
repetisi" — itu yang memulai fase turun dan membuat gerakannya teramati.
`creditMax` menjawab "apakah sampai bawah", dan hanya itu yang menambah
hitungan.

Percobaan yang berbalik di antara keduanya tetap dilaporkan (`counted: false`),
jadi aplikasi bisa menandainya amber dan mengatakan apa yang kurang. Ia cuma
tidak menambah angka.

Sebelumnya kedalaman diperiksa **dua kali di dua tempat**: counter memberi
kredit untuk apa pun yang melewati `downEnter`, lalu rule menandainya dangkal
sesudahnya. Akibatnya satu set berisi dua belas squat setengah menghasilkan dua
belas repetisi **dan** dua belas koreksi. Penghitung yang mengkreditkan setengah
rep mengatakan sesuatu yang tidak benar tentang kerja yang dilakukan, dan
menggelembungkan target yang kemudian dipakai session loop untuk naik.

Sekarang satu ambang, satu tempat, tanpa urutan yang harus dijaga:

| Gerakan | Percobaan (`downEnter`) | Dihitung (`creditMax`) |
|---|---|---|
| Push-up | siku 135° | siku 105° |
| Squat | lutut 140° | lutut 90° — paralel |

`liveCue` membaca `creditMax` yang sama, jadi peringatan "turun lebih dalam"
datang di titik balik, **sebelum** rep-nya ditolak. Aplikasi tidak akan pernah
menolak rep karena dangkal tanpa lebih dulu memperingatkan bahwa ia akan
menolaknya.

### 0c. Lockout dinilai relatif, bukan terhadap ambang tetap

Pose estimator **tidak** membaca sendi yang terkunci sebagai 180°. Ia membaca
apa pun yang dihasilkan penempatan landmark — bergantung pada postur orangnya
dan sudut kamera. Orang yang sama pada 30° dan 45° serong menghasilkan puncak
berbeda untuk form yang identik.

Ambang absolut karena itu mengukur tracker-nya sama banyak dengan pelakunya, dan
uji lapangan menunjukkannya persis: *"berdiri tegak sepenuhnya"* dan *"luruskan
lengan sepenuhnya"* menyala di **setiap** repetisi — rule yang sama sekali tidak
membawa informasi.

Sekarang tiap rep dibandingkan dengan puncak terbaik orang itu sendiri, di set
itu, di bawah kamera itu. Offset sistematisnya saling meniadakan, dan yang
tersisa justru hal yang layak ditandai: **rep yang memendek seiring set
berjalan.** Ambang absolut tetap ada sebagai jaring pengaman, dipasang tepat di
atas gerbang counter.

Satu hal yang perlu diketahui sebelum menghapus rule ini: **gerbang atas counter
sudah menegakkan sebagian besar isinya.** Rep yang tidak melewati `upEnter` tidak
pernah dihitung sama sekali, jadi `partial_lockout` hanya bisa menyala di pita
sempit tepat di atas gerbang itu.

Dan bahkan ketika sah, ia hanya **diucapkan sekali per set**
(`SPEAK_ONCE_PER_SET`). Kedalaman bisa langsung diperbaiki di rep berikutnya —
mengulanginya adalah melatih. Lockout adalah kebiasaan sepanjang set; mendengarnya
dua belas kali bukan dua belas koreksi, melainkan satu koreksi yang diteriakkan
dua belas kali, dan itu menenggelamkan cue yang benar-benar berubah tiap rep.

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
