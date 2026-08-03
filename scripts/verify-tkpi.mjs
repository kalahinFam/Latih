/**
 * Records that the extracted TKPI data has been checked and accepted.
 *
 * ## What `verified: true` means after this runs
 *
 * Not "a human read all 1,144 rows". It means someone compared a sample
 * against panganku.org, found the extraction faithful, and accepted the table.
 * The distinction matters because the paper describes this process, and
 * "verified" would be an overstatement if it implied row-by-row review.
 *
 * The method and sample size are written into `meta.verification` so the claim
 * travels with the data instead of living in someone's memory.
 *
 * Rows marked `suspect` are deliberately left unverified: their own figures
 * contradict each other, so no amount of checking makes them citable.
 *
 * Run: node --experimental-strip-types scripts/verify-tkpi.mjs --sample 15 --by "Nama"
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { markSuspectRows, auditTable } from '../web/src/core/tkpi.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data', 'tkpi', 'tkpi.json');

const args = process.argv.slice(2);
const readArg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const sampleSize = Number(readArg('--sample', '0'));
const checkedBy = readArg('--by', 'tim Kalahin Fam');

const table = JSON.parse(await readFile(DATA, 'utf8'));

// Re-run the consistency pass first, so a row that contradicts itself can
// never be marked verified by this script.
const suspect = markSuspectRows(table);

let verified = 0;
for (const food of table.foods) {
  if (food.suspect) {
    food.verified = false;
    continue;
  }
  food.verified = true;
  verified += 1;
}

table.meta.verification = {
  method:
    'Ekstraksi otomatis dari panganku.org, diperiksa dengan membandingkan sampel acak ' +
    'terhadap halaman sumber. Bukan tinjauan baris per baris.',
  sampleSize: sampleSize > 0 ? sampleSize : null,
  checkedBy,
  checkedAt: new Date().toISOString().slice(0, 10),
  suspectRowsExcluded: suspect.length,
};
delete table.meta.unverifiedWarning;

await writeFile(DATA, JSON.stringify(table, null, 2));

const report = auditTable(table);
console.log(`Ditandai terverifikasi : ${verified} / ${report.total}`);
console.log(`Dikecualikan (suspect) : ${suspect.length}`);
console.log(`Bisa disitir retrieval : ${report.usable}`);
if (sampleSize > 0) console.log(`Ukuran sampel dicatat  : ${sampleSize}`);
else {
  console.warn(
    '\n⚠️  Ukuran sampel tidak dicatat. Jalankan dengan --sample N agar paper\n' +
      '   bisa menyebutkan berapa baris yang benar-benar diperiksa manusia.',
  );
}
console.log('\nLangkah berikutnya:  npm run check:tkpi');
