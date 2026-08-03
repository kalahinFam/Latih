/**
 * Validates the TKPI data file.
 *
 * Runs the same `auditTable` the product's own module exposes, so a row that
 * passes here is a row the app considers sane. Catching a mistranscribed
 * figure at this point costs seconds; catching it inside a judged answer costs
 * the grounding claim.
 *
 * Run: node --experimental-strip-types scripts/check-tkpi.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditTable, medianEnergy } from '../web/src/core/tkpi.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data', 'tkpi', 'tkpi.json');

const table = JSON.parse(await readFile(DATA, 'utf8'));
const report = auditTable(table);

console.log(`Berkas : ${DATA}`);
console.log(`Baris  : ${report.total}`);
console.log(`Terverifikasi : ${report.verified} / ${report.total}`);
console.log(`Bisa disitir  : ${report.usable} (sisanya ditandai suspect)`);
console.log(`Median energi : ${medianEnergy(table)?.toFixed(0) ?? '-'} kkal per 100 g`);

let failed = false;

if (report.acknowledged.length > 0) {
  // Known errors in the published TKPI, already excluded from retrieval.
  // Reported for the record, not treated as a failure — otherwise the check
  // would be red forever and the team would stop reading it.
  console.log(`\nBaris tidak konsisten di sumber, dikecualikan (${report.acknowledged.length}):`);
  for (const row of report.acknowledged) console.log(`  ${row.code}: ${row.reason}`);
}

if (report.duplicateCodes.length > 0) {
  failed = true;
  console.error(`\nKode duplikat (${report.duplicateCodes.length}):`);
  for (const code of report.duplicateCodes) console.error(`  ${code}`);
}

if (report.implausible.length > 0) {
  // Not yet acknowledged: either new source rows or a regression in the
  // extraction. Either way it needs a human before shipping.
  failed = true;
  console.error(`\nBaris tidak konsisten dan BELUM ditandai (${report.implausible.length}):`);
  for (const row of report.implausible) console.error(`  ${row.code}: ${row.reason}`);
  console.error('  Jalankan npm run verify:tkpi untuk menandai, setelah memeriksa penyebabnya.');
}

const unverified = report.usable - report.verified;
if (unverified > 0) {
  console.warn(
    `\n⚠️  ${unverified} baris yang bisa disitir belum diverifikasi.\n` +
      '   Aplikasi memperingatkan pengguna selama flag ini false.\n' +
      '   Lihat data/tkpi/README.md.',
  );
} else if (table.meta.verification) {
  const v = table.meta.verification;
  console.log(
    `\nVerifikasi : ${v.checkedBy}, ${v.checkedAt}` +
      (v.sampleSize ? `, sampel ${v.sampleSize} baris` : ', ukuran sampel tidak dicatat'),
  );
}

if (failed) {
  console.error('\nValidasi GAGAL.');
  process.exit(1);
}

console.log('\nValidasi struktur lolos.');
