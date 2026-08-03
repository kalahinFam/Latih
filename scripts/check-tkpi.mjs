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
console.log(`Median energi : ${medianEnergy(table)?.toFixed(0) ?? '-'} kkal per 100 g`);

let failed = false;

if (report.duplicateCodes.length > 0) {
  failed = true;
  console.error(`\nKode duplikat (${report.duplicateCodes.length}):`);
  for (const code of report.duplicateCodes) console.error(`  ${code}`);
}

if (report.implausible.length > 0) {
  failed = true;
  console.error(`\nBaris mencurigakan (${report.implausible.length}):`);
  for (const row of report.implausible) console.error(`  ${row.code}: ${row.reason}`);
}

if (report.verified < report.total) {
  // A warning, not a failure: the pipeline is meant to be testable before the
  // data is final. It has to be loud, because shipping placeholder nutrition
  // figures under a grounding claim is the worst outcome available here.
  console.warn(
    `\n⚠️  ${report.total - report.verified} baris belum diverifikasi terhadap TKPI resmi.\n` +
      '   Aplikasi akan memperingatkan pengguna selama flag ini false.\n' +
      '   JANGAN pakai data ini di paper, demo yang dinilai, atau video.\n' +
      '   Lihat data/tkpi/README.md untuk cara menggantinya.',
  );
}

if (failed) {
  console.error('\nValidasi GAGAL.');
  process.exit(1);
}

console.log('\nValidasi struktur lolos.');
