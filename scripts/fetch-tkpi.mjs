/**
 * Fetches the TKPI composition table from panganku.org into `data/tkpi/tkpi.json`.
 *
 * ## Why this exists
 *
 * panganku.org lists all 1,146 foods on one page but exposes each food's
 * figures only through a per-food POST, with no bulk export. Copying a few
 * hundred rows by hand is hours of work and introduces exactly the
 * transcription errors the grounding claim cannot survive. This does the same
 * job in minutes and records where every number came from.
 *
 * ## Politeness
 *
 * One request at a time with a delay between them. This is a public health
 * ministry service, and the whole table is a few hundred requests — there is
 * no reason to hammer it.
 *
 * ## What `verified` means after this runs
 *
 * `false` still means "no human has spot-checked this row". The figures now
 * come from the official database rather than a placeholder, which is a large
 * improvement, but automated extraction can still mis-parse. Spot-check a
 * sample and run `npm run check:tkpi` before publishing anything.
 *
 * Run:
 *   node --experimental-strip-types scripts/fetch-tkpi.mjs
 *   node --experimental-strip-types scripts/fetch-tkpi.mjs --limit 150
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { markSuspectRows } from '../web/src/core/tkpi.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'data', 'tkpi', 'tkpi.json');

const BASE = 'https://www.panganku.org/id-ID';
const UA = 'Mozilla/5.0 (compatible; LATIH-Datathon2026/1.0; research use)';
const DELAY_MS = 250;

const args = process.argv.slice(2);
const limitIndex = args.indexOf('--limit');
const LIMIT = limitIndex >= 0 ? Number(args[limitIndex + 1]) : Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Strip tags and collapse whitespace, so the label/value pairs sit adjacent. */
function toText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * panganku.org prints numbers in English convention: period decimal, comma
 * thousands ("1,147.1"). Parsing these as Indonesian would turn 1,147.1 into
 * 1.1471 and quietly corrupt the table.
 */
function parseNumber(raw) {
  const value = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/** Pull `Label ( English ) : <number> <unit>` out of the flattened page text. */
function field(text, label) {
  const re = new RegExp(`${label}\\s*\\([^)]*\\)\\s*:\\s*([\\d.,]+)`, 'i');
  const match = re.exec(text);
  return match ? parseNumber(match[1]) : null;
}

async function fetchList() {
  const response = await fetch(`${BASE}/semua_nutrisi`, { headers: { 'user-agent': UA } });
  if (!response.ok) throw new Error(`Daftar pangan gagal dimuat: HTTP ${response.status}`);
  const html = await response.text();

  const body = html.slice(html.indexOf('<tbody'), html.indexOf('</tbody>'));
  const rows = [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)];

  return rows
    .map((row) => {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => toText(c[1]));
      return cells.length >= 5
        ? { code: cells[1], name: cells[2], group: cells[3], type: cells[4] }
        : null;
    })
    .filter((entry) => entry && /^[A-Z]{2}\d+$/.test(entry.code));
}

async function fetchFood(entry) {
  const response = await fetch(`${BASE}/view`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
    // The site's own row handler posts the food code under this field name.
    body: new URLSearchParams({ haha: entry.code }),
  });
  if (!response.ok) return null;

  const text = toText(await response.text());
  const energyKcal = field(text, 'Energi');
  const proteinG = field(text, 'Protein');
  const fatG = field(text, 'Lemak');
  const carbG = field(text, 'Karbohidrat');
  const fiberG = field(text, 'Serat');

  // A row missing any macronutrient cannot support an answer, and a partial
  // row is worse than an absent one: retrieval would surface it and the model
  // would have nothing to cite.
  if ([energyKcal, proteinG, fatG, carbG].some((v) => v === null)) return null;

  return {
    code: entry.code,
    name: entry.name,
    aliases: aliasesFor(entry.name),
    basisG: 100,
    energyKcal,
    proteinG,
    fatG,
    carbG,
    ...(fiberG !== null ? { fiberG } : {}),
    group: entry.group,
    source: `panganku.org TKPI, kode ${entry.code}`,
    verified: false,
  };
}

/**
 * Everyday name a user is likely to type.
 *
 * TKPI names are precise ("Akar tonjong, segar (Lotus root, fresh)") and nobody
 * types that. Taking the part before the first comma and dropping the
 * parenthesised English gives the word people actually use.
 */
function aliasesFor(name) {
  const short = name.split(',')[0].replace(/\([^)]*\)/g, '').trim().toLowerCase();
  return short && short !== name.toLowerCase() ? [short] : [];
}

console.log('Mengambil daftar pangan…');
const list = await fetchList();
console.log(`  ${list.length} entri ditemukan`);

const wanted = list.slice(0, Number.isFinite(LIMIT) ? LIMIT : list.length);
console.log(`Mengambil komposisi untuk ${wanted.length} entri (jeda ${DELAY_MS} ms)…\n`);

const foods = [];
const skipped = [];

for (const [index, entry] of wanted.entries()) {
  try {
    const food = await fetchFood(entry);
    if (food) foods.push(food);
    else skipped.push(entry.code);
  } catch (error) {
    skipped.push(entry.code);
    console.warn(`  ! ${entry.code} gagal: ${String(error)}`);
  }

  if ((index + 1) % 25 === 0 || index === wanted.length - 1) {
    console.log(`  ${index + 1}/${wanted.length}  (terkumpul ${foods.length}, dilewati ${skipped.length})`);
  }
  await sleep(DELAY_MS);
}

// Mark rows whose own macronutrients contradict their stated energy. Around
// 1% of the published TKPI is inconsistent this way; verified against the
// source, these are errors in the data rather than in this extraction. They
// stay in the file for provenance but are excluded from retrieval.
const suspect = markSuspectRows({ meta: {}, foods });

const table = {
  meta: {
    source: 'panganku.org — Data Komposisi Pangan Indonesia (TKPI)',
    note:
      'Diambil otomatis dari basis data resmi panganku.org. Angka berasal dari TKPI, ' +
      'tetapi belum diperiksa ulang manual — ekstraksi otomatis tetap bisa salah baca. ' +
      'Periksa sampel acak, jalankan npm run check:tkpi, lalu set verified:true.',
    unverifiedWarning:
      'Data diambil otomatis dari panganku.org dan belum diperiksa ulang manual.',
    retrievedAt: new Date().toISOString().slice(0, 10),
  },
  foods,
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(table, null, 2));

console.log(`\nDitulis ke ${OUT}`);
console.log(`  ${foods.length} bahan pangan tersimpan`);
if (skipped.length > 0) {
  console.log(`  ${skipped.length} dilewati karena data makro tidak lengkap`);
}
if (suspect.length > 0) {
  console.log(
    `  ${suspect.length} ditandai suspect (angka di sumber tidak konsisten, dikecualikan dari retrieval)`,
  );
}
console.log('\nLangkah berikutnya:  npm run check:tkpi');
