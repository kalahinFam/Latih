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
| Onboarding enam langkah | ✅ berjalan |
| Koreksi form deterministik + cue | ✅ berjalan |
| Instrumentasi latensi & FPS | ✅ berjalan |
| PWA installable + offline | ✅ berjalan |
| Ekstraksi fitur per repetisi | ✅ berjalan |
| Harness evaluasi rep-count | ✅ berjalan |
| Alat anotasi (video → keypoint berlabel) | ✅ berjalan |
| Slow loop (narasi LLM per set) | ✅ berjalan |
| TTS Bahasa Indonesia (cue) | ✅ berjalan |
| Nutrisi TKPI + verifier grounding | ✅ berjalan, 1.133 bahan pangan |
| Session loop (adaptasi target dari riwayat) | ✅ berjalan |
| Rencana latihan mingguan | ✅ berjalan |
| Target kalori + saran menu dari TKPI | ✅ berjalan |
| Pengingat jam latihan (Web Push) | ✅ berjalan, butuh kunci VAPID |
| Tanya pelatih saat istirahat (suara + ketik) | ✅ berjalan |
| Substitusi gerakan dari keluhan + catatan keluhan | ✅ berjalan |
| Batas belanja endpoint berbayar | ✅ berjalan, dua lapis |
| Cadangan data (ekspor/impor file) | ✅ berjalan |
| Klasifier form (ONNX) | ⬜ tidak dikerjakan |

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
| `npm test` | Unit test (627 tes) |
| `npm run gen:vapid` | Membangkitkan sepasang kunci Web Push |
| `npm run tts:lab` | Contoh suara pelatih untuk dibandingkan (folder `tts-lab/`) |
| `npm run gen:cues -- --force` | Membangkitkan ulang klip cue setelah ganti suara |
| `npm run typecheck` | Pemeriksaan tipe tanpa build |
| `npm run build` | Build produksi ke `dist/` |
| `npm run preview` | Menyajikan hasil build (untuk uji PWA) |
| `npm run setup:assets` | Mengambil ulang model + WASM |
| `npm run gen:icons` | Membangkitkan ulang ikon PWA |
| `npm run bench:fastloop` | Biaya komputasi fast loop per frame (**bukan** latensi perangkat) |
| `npm run eval:reps` | Harness akurasi rep-count |
| `npm run eval:grounding` | Baterai grounding TKPI (butuh `npm run dev` + kunci API) |
| `npm run check:tkpi` | Validasi tabel TKPI (kode ganda, basis, Atwater) |

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
│   ├── split.ts        gerakan per hari latihan, dari jawaban onboarding
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
logika, jadi angka yang dilaporkan di paper dijamin berasal dari kode yang
benar-benar dipakai produk.

Dua hal yang membuat ini bekerja, dan yang akan merusaknya kalau diubah:

- **Setiap import relatif memakai ekstensi `.ts` eksplisit.** Node ESM tidak
  menebak ekstensi seperti bundler. Menghapusnya membuat skrip evaluasi gagal
  resolve, meski aplikasi tetap jalan.
- **`erasableSyntaxOnly` aktif di `tsconfig.json`.** Ini melarang sintaks
  TypeScript yang menghasilkan kode saat runtime (enum, parameter property),
  sehingga Node bisa sekadar melucuti tipe tanpa mengompilasi.

---

## Slow loop — narasi pelatih per set

Tekan **STOP** setelah selesai. Klien mengirim ringkasan set ke `/api/coach`,
yang mengembalikan narasi Bahasa Indonesia dua sampai tiga kalimat plus satu
fokus untuk set berikutnya.

**Yang keluar dari perangkat hanyalah ringkasan itu:** jumlah repetisi, sudut
sendi dalam derajat, durasi, dan kode kesalahan. Tidak ada frame, tidak ada
koordinat landmark. Endpoint menolak payload apa pun yang mengandung data pose
**sebelum** sampai ke model — pertahanan berlapis, karena klien memang tidak
bisa menyusun payload seperti itu dari tipe `SetSummary`.

**Perbandingan angka dikerjakan di kode, bukan diserahkan ke model.**
`directivesFor()` mengevaluasi setiap ambang lalu menyuntikkan baris
`INSTRUKSI:` tanpa syarat. Alasannya empiris: diberi angka mentah, model
mengarang kekurangan pada set tanpa cacat, mengubah "naik 2 repetisi" menjadi
"dua kali lipat", dan memuji "kemajuan" pada sesi yang justru kehilangan 4
repetisi dan 9° kedalaman — semuanya kesalahan yang sama, yaitu meminta model
mengevaluasi ambang numerik dan mengingat sebuah kondisional.

Setiap respons membawa `usage` dan `latencyMs`, jadi angka biaya dan latensi di
paper diambil dari trafik nyata, bukan estimasi.

**Jalur kegagalan** (semuanya menurunkan kualitas, tidak mematikan latihan):
offline dan timeout 15 detik dilewati dengan pesan; kunci belum diset
menghasilkan instruksi konkret; set nol repetisi dijawab langsung tanpa
memanggil model sama sekali.

---

## Session loop — target yang menyesuaikan diri

Loop ketiga dan paling lambat: melihat lintas sesi dan menentukan apa yang
diminta berikutnya. `core/sessionLoop.ts` (logika murni) + `session/history.ts`
(penyimpanan).

**Riwayat tidak pernah meninggalkan perangkat.** Disimpan di `localStorage`,
maksimal 500 set. Yang ikut ke `/api/coach` hanya angka turunannya — target,
selisih repetisi, selisih kedalaman — bukan lognya.

**Tiga aturan yang membentuknya:**

- **Kualitas menjadi syarat kenaikan, bukan hanya jumlah.** Kalau target
  tercapai tapi >25% rep kena flag, target ditahan dan narasi diarahkan ke form
  — aturan naif "kemarin lebih banyak, naikkan" melatih orang mengejar angka
  dengan memangkas kedalaman, persis kesalahan yang dibangun fast loop untuk
  menangkapnya.
- **Butuh dua sesi berturut-turut**, karena satu sesi bagus itu derau.
- **Dinilai dari set terbaik sesi itu, bukan set terakhir.** Kelelahan membuat
  set belakangan selalu lebih rendah; menilai dari yang terakhir akan membaca
  setiap latihan normal sebagai kemunduran.

Sesi dengan `trackingQuality` di bawah 0.7 **dilewati sepenuhnya**, tidak
dihitung sebagai kegagalan — yang bermasalah kameranya, bukan orangnya.

---

## Tanya pelatih saat istirahat

Di sela set, pengguna bisa bicara ke pelatih — "habis ini apa?", atau "lutut
kiriku sakit". Yang pertama dijawab dari rencana yang sudah dipegang perangkat.
Yang kedua **mengganti gerakan berikutnya dan mencatat keluhannya.**

**Model membaca kalimatnya; kode yang memutuskan akibatnya.** Model
mengembalikan bagian tubuh dari daftar tertutup, sisi, dan maksudnya — lalu
tabel di `core/restChat.ts` yang menentukan penggantinya. Model yang bebas
memilih pada akhirnya akan menjawab keluhan lutut dengan lunge, yang membebani
lutut yang sama dan juga tidak bisa dihitung kamera. Prompt-nya melarang model
menyebut gerakan pengganti sama sekali.

**Penggantinya sengaja bukan `MovementKind`.** Glute bridge tidak bisa dinilai
kamera, jadi tiap `SubstituteMovement` membawa `tracked: false` dan layarnya
berkata apa adanya — *"kamera belum bisa menghitung gerakan ini, jadi set-nya
tidak dihitung otomatis"*. Produk yang mengklaim mengamati berutang kejujuran
tentang set yang tidak diamatinya.

**Batas medisnya struktural.** Substitusi berlaku sampai tengah malam lalu
hilang, karena lutut yang sakit hari Selasa bukan bukti tentang hari Kamis dan
aplikasi tidak punya cara tahu apakah sudah sembuh. Keluhannya sendiri tetap
disimpan. Tiga keluhan tentang bagian yang sama dalam 14 hari memunculkan
kalimat rujukan tetap, dimiliki kode dan tidak pernah dirangkai model.

**Suara adalah satu-satunya jalur yang keluar dari perangkat.** Web Speech API
tidak mentranskrip di perangkat: audionya dikirim ke layanan pengenal suara
milik browser. Frame kamera tetap tidak pernah dikirim dan klaim itu utuh, tapi
keduanya tidak boleh digambarkan seolah bekerja sama — jadi kalimatnya ditempel
persis di sebelah tombol mikrofon, bukan di halaman pengaturan yang tak pernah
dibuka. Ada kolom ketik di sebelahnya: Firefox tidak mendukung sama sekali, iOS
berbeda-beda per versi.

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
melintasi setiap transisi itu. Halaman terpisah membongkar `getUserMedia` dan
menginisialisasi ulang MediaPipe tiap berpindah — layar hitam beberapa detik di
tengah latihan. Elemen `<video>` hidup di lapisan tersendiri di luar layar-layar
itu. Hash dipakai alih-alih History API karena aplikasinya disajikan sebagai
berkas statis.

**Onboarding** enam langkah (`STEPS` di `ui/screens/onboardingScreen.ts`), dan setiap
pertanyaan ada karena ada yang menghitung dengan jawabannya: usia, jenis
kelamin, tinggi, dan berat untuk Mifflin-St Jeor; aktivitas untuk pengalinya;
tujuan untuk arah penyesuaian kalori; pengalaman untuk target repetisi pertama;
pantangan untuk menyaring baris TKPI. Layar penutupnya menunjukkan hitungannya,
dirender dari `core/energy.ts` saat ditampilkan — tidak ada angka yang ditulis
di markup. **Pantangan ditegakkan, bukan diminta:** baris yang dikecualikan
dihapus dari pantry *sebelum* prompt dibangun, dan diuji ke endpoint hidup —
tanpa pantangan model memakai ayam dan udang; dengan pantangan, **nol
pelanggaran dari tiga skenario**.

**Layar posisi kamera memberi centang hanya untuk yang diukur:** badan utuh di
frame, dan jarak kasar lewat `bodyFill`. Sudut dan tinggi kamera tidak diukur
sama sekali, jadi keduanya jadi panduan tertulis tanpa centang — centang yang
artinya "kami asumsikan begitu" akan membuat dua centang lainnya tidak berarti.

**Plank punya mesin tersendiri** (`core/holdTracker.ts`): repetisi adalah
peristiwa, tahanan adalah keadaan. Putusnya garis pinggul **menghentikan jam,
bukan mengakhiri set**, dengan grace 300 ms. Kameranya juga beda — push-up dan
squat minta serong 30–45°, plank minta samping penuh.

**Layar latihan** dibaca dari ±2 m dari ketinggian lantai: satu angka besar,
sisanya di tepi; angkanya sendiri yang berubah warna (sage benar, amber ada
koreksi) sehingga sinyal dan benda yang dilihat adalah objek yang sama; dan
angka ditaruh di sepertiga bawah karena dari lantai arah pandang jatuh ke sana.

---

## Rencana mingguan dan target kalori

Session loop memutuskan **berapa repetisi**; rencana mingguan memutuskan **kapan
menagihnya**. Progresi bergerak di **satu sumbu** — set tetap, repetisi bergerak
— karena menaikkan keduanya sekaligus membuat beban berubah tak terduga dan
adaptasinya tidak bisa dijelaskan dalam satu kalimat. Hari disebar, bukan
digumpalkan: tiga sesi di Jumat–Minggu nominalnya sama dengan Senin–Rabu–Jumat,
dan nyatanya minggu yang jauh lebih buruk.

Target kalori memakai Mifflin-St Jeor (1990) di `core/energy.ts`, dihitung **di
perangkat**; `MealsRequest` memang tidak punya tempat untuk berat atau usia —
cara yang sama dengan `SetSummary` yang tidak punya tempat untuk frame video.
Hasilnya **rentang, bukan satu angka** (persamaannya akurat dalam 10% untuk
sekitar 70% orang), ada **dua batas bawah** sehingga app tidak pernah
menyarankan asupan di bawah metabolisme basal, dan **input di luar rentang
ditolak, bukan diekstrapolasi**.

---

## Saran menu — di mana verifier lama tidak cukup

Ini kasus yang tidak bisa ditangkap verifier grounding yang sudah ada. Verifier
itu memeriksa apakah sebuah angka **muncul** di baris hasil retrieval. Total
sebuah menu tidak muncul di baris mana pun karena ia **turunan** — dan total
yang salah, dirakit dari bahan-bahan yang setiap angkanya asli dari TKPI, akan
lolos.

Jadi pembagian kerjanya digeser: **model memilih bahan dan porsi**, dan setiap
angka setelah itu dihitung di `core/meals.ts` dari baris TKPI yang kodenya
merujuk. Pantry-nya dikurasi **per kode TKPI**, bukan lewat pencarian kata kunci
— mencari "ayam" mengembalikan ayam goreng tiga jaringan restoran sebelum sampai
ke ayam biasa. Ada tes yang memastikan setiap kode merujuk ke baris nyata yang
tidak ditandai `suspect`, jadi salah ketik satu kode menggagalkan build.

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
terlepas dari apakah aplikasinya sedang dibuka.

**Push tanpa payload.** Server mengirim bangunan kosong; teksnya disusun di
service worker, di perangkat. Layanan push — Google atau Mozilla, tergantung
browser — merelai notifikasi yang isinya tidak pernah ia lihat.

```bash
npm run gen:vapid          # → VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
```

Isikan keduanya ke `.env` dan ke Environment Variables di Vercel. Tanpa itu,
tombol pengingat otomatis disembunyikan dan sisa aplikasi berjalan normal.

Langganan disimpan di Upstash Redis lewat REST API-nya; kalau
`UPSTASH_REDIS_REST_URL` belum diisi, penyimpanan jatuh ke memori — cukup untuk
lokal, hilang tiap deploy, dan halaman Rencana mengatakannya apa adanya. Di
iPhone push hanya sampai ke PWA yang sudah ditambahkan ke Layar Utama, dan
`reminderSupport()` melaporkan alasannya alih-alih menampilkan tombol yang
diam-diam tidak melakukan apa-apa.

---

## Nutrisi TKPI — grounding yang bisa diperiksa, bukan diklaim

**1.144 bahan pangan**, diekstrak otomatis dari
[panganku.org](https://www.panganku.org/id-ID/view) — basis data resmi TKPI.
1.133 bisa disitir; 11 dikecualikan karena angkanya tidak konsisten **di
sumbernya sendiri** (lihat [`data/tkpi/README.md`](data/tkpi/README.md)).

**Tanya gizi** adalah layar sendiri, dibuka dari Gizi. Tiap jawaban muncul
**beserta baris TKPI yang dipakai**, lengkap dengan angka dan sumbernya, supaya
siapa pun — termasuk juri — bisa mencocokkannya sendiri tanpa meninggalkan
halaman.

Bisa **diketik atau dipilih**, karena keduanya gagal dengan cara berbeda.
Ketikan menjangkau seluruh tabel tapi juga bisa meleset — kalau retrieval tidak
menemukan apa pun, jawabannya adalah penolakan. Pertanyaan yang ditawarkan tidak
mungkin meleset: katalognya ada di `core/nutritionQuestions.ts`, dan setiap
pertanyaan yang bisa dihasilkannya diuji terhadap tabel TKPI asli di
`test/nutritionQuestions.test.ts` — saran yang tidak bisa dijawab menggagalkan
build, bukan percakapan.

**Alur, dan kenapa tiap langkahnya ada:**

1. **Retrieval** mencari bahan yang disebut pertanyaan. Kalau tidak ada yang
   cocok, model **tidak dipanggil sama sekali** — tanpa baris data, tidak ada
   yang bisa menjadi dasar jawaban, dan bertanya tetap adalah persis cara sebuah
   angka karangan diproduksi. Khusus percakapan: pertanyaan susulan sering tidak
   menyebut bahannya sama sekali ("kalau tahu?"), jadi retrieval diulang bersama
   pertanyaan sebelumnya — hanya kalau perlu, karena tiap baris tambahan
   memperluas himpunan angka yang diterima verifier, dan himpunan itulah
   jaminannya.
2. **Model hanya menerima baris hasil retrieval**, dengan larangan eksplisit
   menghitung, mengalikan, atau memakai pengetahuannya sendiri.
3. **Verifier memeriksa setiap angka** di jawaban terhadap baris tersebut.
4. **Gagal → tulis ulang sekali** dengan instruksi lebih ketat.
5. **Gagal lagi → narasi dibuang**, tabel mentah tetap ditampilkan.

Langkah terakhir itu intinya. Asisten gizi yang sesekali mengarang angka masuk
akal lebih buruk daripada yang kadang menolak menulis prosa, karena pengguna
tidak bisa membedakan keduanya. Menolak adalah kegagalan yang jujur.

Yang ikut dikirim bersama pertanyaan hanyalah **angka turunan**: target energi
dan protein harian yang sudah dihitung di perangkat. Berat, tinggi, usia, dan
jenis kelamin tidak punya tempat di tipe permintaannya.

**Yang diperiksa hanya angka berunit.** Klaim gizi selalu punya satuan — "20,8
gram protein", "201 kkal". Angka telanjang adalah hitungan ("dua bahan"), bukan
klaim komposisi; memeriksanya akan menolak jawaban benar dan tim akan mematikan
verifier-nya. Angka Indonesia dibaca sesuai konvensinya: koma desimal, titik
ribuan. Membaca "20,8" ala Inggris menghasilkan 208 dan membuat setiap
pemeriksaan gagal.

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
sementara "unta" tidak cocok dengan apa pun. Jawabannya tetap benar ("data tidak
tersedia"), tapi empat bahan tak relevan tampil sebagai sumbernya.

Perbaikannya: sebuah kecocokan hanya diterima kalau setidaknya satu kata yang
cocok **cukup khas** — muncul di ≤3% nama pangan. Percobaan pertama salah secara
instruktif: mensyaratkan kecocokan menjelaskan *sebagian besar* pertanyaan
menolak *"tempe tahu telur ayam"* mentah-mentah, karena dengan empat bahan
disebut tidak ada satu baris pun yang bisa menjelaskan mayoritasnya.

### Validasi data

```bash
npm run check:tkpi
```

Memeriksa kode duplikat, basis bukan 100 g, dan konsistensi Atwater
(protein×4 + karbo×4 + lemak×9 ≈ energi).

Pemeriksaan ini menemukan **11 baris (0,96%) yang angkanya bertentangan dengan
dirinya sendiri di data resmi TKPI** — sudah dicocokkan langsung ke halaman
sumber. Baris itu disimpan demi provenance, ditandai `suspect`, dan dikecualikan
dari retrieval. Sistem yang grounded pada sumber eksternal tetap harus
memvalidasi sumbernya.

---

## Suara — cue koreksi, MP3 pra-render

Himpunan frasa koreksi tertutup — tujuh kalimat, terdaftar di `CUE_TEXT` pada
`core/rules.ts`. Semuanya dibangkitkan jadi MP3 saat build oleh
`scripts/gen-cues.mjs`, lalu diputar tanpa jaringan sama sekali.

Alasannya: cue yang datang satu detik terlambat **bukan cue yang telat, tapi cue
yang salah** — repetisi yang dibicarakannya sudah lewat. Memanggil TTS di tengah
set juga berbiaya tiap repetisi dan langsung bisu saat WiFi bermasalah.

Nama berkasnya mengandung hash dari **teksnya**. Mengedit sebuah frasa
menghasilkan nama baru, sehingga rekaman lama berhenti dirujuk — bukan diam-diam
terputar mengucapkan koreksi yang sudah tidak berlaku. Konsekuensinya: ganti
suara tanpa `npm run gen:cues -- --force` dan klip lama tetap dipakai.

Kalau klip gagal diputar — offline, kunci belum diset, kuota habis — playback
jatuh ke `speechSynthesis` bawaan browser. Mana yang sedang berbunyi bisa
diperiksa di konsol perangkat:

```js
latih.engine.audioSource   // 'clip' | 'browser' | null
```

Narasi antar-set ditampilkan sebagai teks di layar Umpan balik, tidak dibacakan
suara.

---

## Alat anotasi

Buka **http://localhost:5174/annotate.html** setelah `npm run dev`.

Alur: pilih video → ekstrak keypoint → periksa segmentasi repetisi → beri label
kelas kesalahan → unduh JSON.

**Ekstraksi dilakukan di browser, bukan lewat Python**, karena alat ini memakai
`PoseSource` dan `RepCounter` yang **sama persis** dengan aplikasi. MediaPipe
Python dan MediaPipe JS adalah jalur implementasi berbeda meski bobot modelnya
sama; perbedaan numerik sekecil apa pun membuat angka evaluasi menggambarkan
harness, bukan produk.

**Dua aturan yang menjaga dataset tetap sahih:**

1. **Label rule tidak pernah dicentang otomatis.** Dugaan dari `rules.ts` muncul
   di kolom terpisah (`suggested`), tidak pernah disalin ke `labels` — dataset
   yang diunggulkan dari keluaran rule mengajari classifier meniru rule, dan
   ablation *rule-only* vs *rule+classifier* jadi membandingkan sesuatu dengan
   salinannya sendiri.
2. **Subject ID wajib diisi**, karena pemisahan train/test harus per orang.
   Kalau repetisi dari orang yang sama bocor ke kedua sisi, F1 terlihat bagus
   secara palsu.

Ekspor ditolak jika hitungan tersegmentasi tidak cocok dengan hitungan manual,
deteksi pose di bawah 60%, atau Subject ID kosong. Selisih antara hitungan
manual dan hitungan otomatis **adalah** data akurasi rep-count.

---

## Evaluasi

```bash
npm run eval:reps
```

Tanpa data terekam, skrip menjalankan **self-check sintetis** dan menandai
hasilnya sebagai bukan angka akurasi — supaya angka sintetis tidak pernah
tersalin ke paper sebagai hasil pengukuran. Setelah anotasi tersedia, jalankan
dengan `--input eval/data`. Hasil ditulis ke `eval/results/rep_accuracy.json`.

### Biaya fast loop, terpisah dari inference

```bash
npm run bench:fastloop
```

Memutar sesi squat lewat modul `core/` yang **sama persis** dengan yang dipakai
browser, dengan urutan panggilan yang sama seperti di `ui/workoutEngine.ts`:
framing, sudut sendi, posture gate, median filter, counter, rep window, rules.
Hasil ditulis ke `eval/results/fastloop_cost.json`.

**Ini bukan angka latensi perangkat, dan tidak boleh dilaporkan sebagai itu.**
Yang diukur cuma aritmetika atas 33 titik; biaya inference MediaPipe bergantung
pada GPU dan kondisi termal, dan hanya bisa diukur di HP sungguhan lewat
`latih.engine.performance`. Gunanya satu: turunan budget cue di paper baru jujur
kalau suku `core/`-nya memang bisa diabaikan terhadap periode frame. Skrip
menolak mengeluarkan angka kalau tidak ada repetisi yang terhitung — artinya
yang terukur cuma early return, bukan loop-nya.

---

## Enam keputusan desain yang perlu diketahui sebelum mengubah kode

### 1. Jangan rata-ratakan sisi kiri dan kanan begitu saja

`reliableMean` di `core/angles.ts`, dan ini perbaikan terpenting yang lahir dari
uji lapangan.

MediaPipe **tidak menghilangkan** anggota badan yang tertutup — ia menebaknya,
dan melaporkan visibility yang tetap di atas ambang mana pun yang masuk akal
dipasang. Ongkosnya terukur: dari sudut serong, push-up di posisi bawah
menyembunyikan lengan jauh di balik badan dan MediaPipe menebaknya hampir lurus.
Siku dekat terbaca ~95°, yang jauh ~170°, rata-ratanya ~132° — tepat di bawah
gate 135 pada frame bagus dan di atasnya pada frame jelek. Hasilnya penghitung
yang bekerja selama lengan terbuka dan berhenti persis saat gerakannya jadi
berarti: dilaporkan sebagai push-up "hampir gapernah" terhitung, sementara
lambaian tangan acak terhitung mulus. Mekanisme yang sama membuat squat terbaca
lebih dalam daripada nyatanya. Rata-rata tetap dipakai kalau kedua sisi
sama-sama terlihat baik; di luar itu, ambil sisi yang terlihat.

### 2. Sudut sendi tidak bisa menjawab "apakah gerakan ini sedang terjadi"

`core/posture.ts`. Lutut yang menekuk lalu lurus terbaca identik entah orangnya
berdiri atau berbaring — dilaporkan sebagai "kayak knee crunch dihitung asal
kaki ditekuk trus dilurusin". Yang membedakan adalah orientasi badan, dan itu
tidak ada di sudut sendi.

Ambangnya sengaja jauh lebih longgar daripada form yang baik. Ini **bukan** rule
form dan tidak boleh menolak repetisi nyata: squat dalam mencondongkan badan
jauh ke depan. Yang ditolak hanya kasus yang tidak ambigu — orang berbaring,
duduk, atau berdiri diam. Kalau tidak bisa memastikan, ia mengizinkan.

### 3. Setengah rep dilihat, tapi tidak dihitung

Counter punya **dua** ambang. `downEnter` menjawab "apakah ada percobaan
repetisi"; `creditMax` menjawab "apakah sampai bawah", dan hanya itu yang
menambah hitungan. Percobaan yang berbalik di antara keduanya tetap dilaporkan
(`counted: false`), jadi aplikasi bisa menandainya amber.

Sebelumnya kedalaman diperiksa **dua kali di dua tempat**: counter memberi
kredit untuk apa pun yang melewati `downEnter`, lalu rule menandainya dangkal
sesudahnya. Akibatnya dua belas squat setengah menghasilkan dua belas repetisi
**dan** dua belas koreksi, sekaligus menggelembungkan target yang kemudian
dipakai session loop untuk naik.

| Gerakan | Percobaan (`downEnter`) | Dihitung (`creditMax`) |
|---|---|---|
| Push-up | siku 135° | siku 105° |
| Squat | lutut 140° | lutut 90° — paralel |

`liveCue` membaca `creditMax` yang sama, jadi peringatan "turun lebih dalam"
datang di titik balik, **sebelum** rep-nya ditolak.

### 4. Lockout dinilai relatif, bukan terhadap ambang tetap

Pose estimator **tidak** membaca sendi yang terkunci sebagai 180°. Ia membaca
apa pun yang dihasilkan penempatan landmark — bergantung pada postur orangnya
dan sudut kamera; orang yang sama pada 30° dan 45° serong menghasilkan puncak
berbeda untuk form yang identik. Ambang absolut karena itu mengukur tracker-nya
sama banyak dengan pelakunya, dan uji lapangan menunjukkannya persis:
*"luruskan lengan sepenuhnya"* menyala di **setiap** repetisi.

Sekarang tiap rep dibandingkan dengan puncak terbaik orang itu sendiri, di set
itu, di bawah kamera itu. Offset sistematisnya saling meniadakan, dan yang
tersisa justru hal yang layak ditandai: **rep yang memendek seiring set
berjalan.** Ambang absolut tetap ada sebagai jaring pengaman, dan cue-nya hanya
**diucapkan sekali per set** (`SPEAK_ONCE_PER_SET`) — lockout adalah kebiasaan
sepanjang set, dan mendengarnya dua belas kali menenggelamkan cue yang
benar-benar berubah tiap rep.

### 5. Gate counter harus lebih longgar daripada ambang rule

Penghitung repetisi menghitung **percobaan**; rules menilai **kualitasnya**.
Rules hanya melihat repetisi yang berhasil dihitung counter.

Kalau `downEnter` disamakan dengan `depthMax` (ambang rule), setiap repetisi
yang terhitung otomatis lolos ambang — dan rule `shallow_depth` menjadi kode
mati yang tetap terlihat benar saat dibaca sendirian. Bug ini pernah terjadi dan
lolos unit test, karena tes membangun window sintetis yang bisa memuat sudut apa
pun. `rules.test.ts` sekarang memeriksa relasi ini langsung terhadap
`DEFAULT_CONFIGS`.

### 6. Sudut dihitung dari world landmarks, bukan koordinat gambar

MediaPipe mengembalikan dua set koordinat. `landmarks` dinormalisasi ke [0,1]
**secara terpisah** untuk lebar dan tinggi — sehingga langkah yang sama pada x
dan y bukan jarak fisik yang sama. Menghitung sudut dari sana menghasilkan nilai
yang salah, dan besar kesalahannya berubah mengikuti rasio aspek kamera.
`worldLandmarks` bersifat metrik dan bebas distorsi itu. Koordinat gambar hanya
dipakai untuk menggambar overlay.

---

## Deploy

Disajikan sebagai berkas statis plus serverless function di Vercel; `vercel.json`
mengatur build dan runtime function. Penjadwal pengingat sengaja **tidak** ada di
sana — lihat di bawah.

**Kamera menuntut HTTPS.** `getUserMedia` menolak berjalan di origin yang tidak
aman, jadi alamat LAN tidak akan pernah cukup — domain ber-TLS bukan pemanis,
melainkan syarat aplikasi ini berfungsi sama sekali.

### Fungsi serverless ditulis di `server/`, dikirim dari `api/`

`npm run build:api` mem-bundle tiap endpoint di `server/` menjadi satu berkas
mandiri di `api/`. Vercel hanya melihat hasil bundelnya; yang layak dibaca dan
direview adalah sumbernya.

**`api/` ikut di-commit meski hasil build.** Vercel memvalidasi pola `functions`
di `vercel.json` terhadap repo yang baru di-clone, sebelum perintah build
dijalankan; direktori yang baru muncul saat build belum ada pada saat itu, dan
deploy gagal dengan *"doesn't match any Serverless Functions"*. Build tetap
membangkitkannya ulang setiap kali, jadi yang benar-benar dikirim selalu dibangun
dari `server/` yang sekarang.

Mem-bundle juga menyelesaikan satu ketidaksepakatan nyata. Setiap import relatif
menulis ekstensi `.ts` eksplisit demi harness evaluasi, tapi Vercel mengompilasi
tiap berkas terpisah dan membiarkan spesifiernya apa adanya — `nutrition.js`
hasil kompilasi tetap meminta `'./_llm.ts'`, berkas yang sudah tidak ada; deploy
sukses, tiap permintaan mati dengan `ERR_MODULE_NOT_FOUND`. Dua perbaikan yang
tampak jelas ditolak berdasarkan bukti: `rewriteRelativeImportExtensions`
dipatuhi `tsc` tapi **tidak oleh esbuild**, dan esbuild-lah yang dijalankan
Vercel; sementara menulis `.js` di spesifiernya memuaskan TypeScript dan Vercel
lalu merusak Node.

`includeFiles` di `vercel.json` membawa serta `data/tkpi/**`: jalur berkasnya
dihitung saat runtime, jadi penelusuran dependensi tidak bisa melihatnya dan
tabel gizinya akan hilang dari bundel tanpa itu.

### Environment variables

| Var | Tanpa ini |
|---|---|
| `OPENAI_API_KEY` | narasi, gizi, saran menu, dan suara mati; fast loop tetap utuh |
| `ALLOWED_ORIGIN` | pemeriksaan asal dilewati — isi di produksi |
| `LLM_DAILY_QUOTA` | plafon harian memakai default 1500 panggilan |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | rate limit dan langganan pengingat jatuh ke memori per-instance |
| `VAPID_PUBLIC_KEY` / `_PRIVATE_KEY` / `VAPID_SUBJECT` | tombol pengingat menyembunyikan diri |
| `CRON_SECRET` | `/api/cron-reminders` terbuka untuk siapa saja |

Penjelasan tiap variabel ada di `.env.example`.

### Batas belanja pada endpoint berbayar

Ketiga endpoint yang memanggil model — `/api/coach`, `/api/nutrition`,
`/api/meals` — tidak memakai autentikasi, karena produk ini tidak punya akun dan
menambahkannya hanya demi melindungi sebuah kunci adalah fitur besar untuk
pertanyaan kecil. Yang menggantikannya ada di `server/_ratelimit.ts`, dua lapis,
karena keduanya gagal dengan cara berbeda:

- **Per klien, per jam** menghentikan kasus biasa: satu orang, satu skrip, satu
  sore. Longgar terhadap latihan sungguhan — satu set menghasilkan tepat satu
  panggilan coach, jadi 30 per jam sudah sekitar enam sesi penuh.
- **Global per hari** yang membatasi tagihan, karena batas per klien tidak
  berarti apa pun kalau permintaannya tersebar dari banyak alamat.

Alamat IP di-hash sebelum dipakai sebagai kunci: limiter perlu mengenali
pengunjung yang sama, bukan tahu siapa dia. Kalau Redis-nya mati, permintaan
**diloloskan** — kehilangan limiter itu masalah biaya, menolak semua permintaan
mematikan produknya.

**Lapisan ketiga ada di luar repo dan paling menentukan:** set *hard budget
limit* pada kunci OpenAI-nya. Kode bisa salah; plafon di sisi provider tidak bisa
diakali.

### Pemicu pengingat ada di luar Vercel

`vercel.json` **tidak** memuat blok `crons`, dan itu disengaja: paket Hobby
membatasi cron jadi sekali sehari, sementara pengingat harus mengejar jam yang
berbeda-beda per pengguna. Menyisakannya di sana berarti deploy ditolak.

Pakai scheduler mana pun yang bisa memanggil URL tiap 15 menit —
[cron-job.org](https://cron-job.org) gratis dan cukup tepat waktu:

```
URL     : https://<domainmu>/api/cron-reminders
Interval: setiap 15 menit
Header  : Authorization: Bearer <CRON_SECRET>
```

Header itu wajib. Tanpanya `isAuthorized()` menolak dengan 401 — dan kalau
`CRON_SECRET` sendiri tidak diset, ia justru meloloskan semua orang. Lima belas
menit bukan angka sembarangan: `isDue()` menerima slot yang terlewat sampai dua
puluh menit, jadi satu jalannya cron yang meleset tidak membuat pengingat hilang
sama sekali.

### Cek sebelum membagikan URL-nya

```bash
npm test && npm run typecheck
npm run build
grep -r "sk-" web/dist/     # harus kosong
```

Lalu, terhadap domain sungguhan: cabut sementara `OPENAI_API_KEY` dan pastikan
hitungan repetisi serta cue tetap berjalan penuh — kalau latihan ikut mati saat
model tidak tersedia, ada jalur yang keliru menganggap jaringan wajib.

---

## Klaim privasi — cara memverifikasinya sendiri

Frame kamera tidak pernah meninggalkan perangkat. Ini ditegakkan oleh kode,
bukan janji:

1. Jalankan aplikasi, lakukan satu set, buka **DevTools → Network**. Buka
   payload POST `/api/coach` yang menutup set itu — **itulah satu-satunya** yang
   dikirim keluar. Isinya hitungan, sudut sendi dalam derajat, durasi, dan kode
   error; tidak ada field yang bisa memuat frame.
2. Di Console, jalankan `localStorage.getItem('latih.history.v1')` — seluruh
   riwayat latihan Anda ada di situ, di perangkat, tidak disinkronkan ke mana
   pun.
3. `assertNoRawPoseData()` di `core/setSummary.ts` menolak payload yang
   mengandung `landmark`, `image`, `frame`, atau `base64`. Ada unit test yang
   sengaja menyelundupkan koordinat dan memastikan fungsi itu melempar error.
4. Matikan koneksi internet — penghitung repetisi dan cue tetap berjalan penuh.

Yang keempat paling kuat justru karena paling sederhana: ia klaim tentang **di
mana komputasinya terjadi**, dan bisa diuji tanpa laptop dan tanpa mempercayai
kami sedikit pun.

---

## Model & dataset

**Tidak ada bobot model yang kami latih sendiri, jadi tidak ada artefak Hugging
Face untuk submisi ini.** Ini keputusan sadar, bukan kelalaian:

- **Pose estimation** memakai **MediaPipe Pose Landmarker (BlazePose GHUM)**
  dari Google, dipakai apa adanya sebagai model pra-latih dan diunduh otomatis
  oleh `npm run setup:assets`. Bobotnya milik Google, bukan artefak yang kami
  hasilkan atau boleh redistribusikan.
- **Klasifier form tidak dikerjakan** (lihat tabel status), jadi tidak ada bobot
  hasil pelatihan kami yang bisa diunggah. `core/features.ts` tetap ada sebagai
  jalur masuknya kalau nanti dilatih.
- **Satu-satunya dataset adalah TKPI**, tabel komposisi pangan resmi Kementerian
  Kesehatan RI. Ia dipakai sebagai **sumber grounding saat runtime**, bukan data
  latih — tidak ada model yang dilatih, di-fine-tune, atau dievaluasi terhadap
  distribusinya. Tabelnya di-commit di `data/tkpi/tkpi.json` supaya hasil di
  paper bisa direproduksi langsung dari repo tanpa unduhan eksternal.

Yang kami tambahkan di atas TKPI ada di repo dan bisa dijalankan sendiri:
skrip ekstraksi dari panganku.org, catatan ekstraksi dan pengecualian di
[`data/tkpi/README.md`](data/tkpi/README.md), serta validasi Atwater yang
menemukan 11 baris tidak konsisten — reproduksinya `npm run check:tkpi`.

---

## Lisensi

**Hak cipta © 2026 Tim Kalahin Fam. Semua hak dilindungi.**

Kode ini dipublikasikan untuk penjurian Datathon 2026 — supaya juri bisa
membaca, membangun, dan memverifikasi setiap klaim di dokumen ini sendiri.
Tidak ada lisensi pemakaian ulang yang diberikan: menyalin, memodifikasi,
mendistribusikan ulang, atau memakainya untuk keperluan lain memerlukan izin
tertulis dari tim.

Ketentuan ini bisa berubah setelah penjurian selesai.
