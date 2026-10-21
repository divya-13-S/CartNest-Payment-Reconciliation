// Quick inspection script — prints sheet names and first row keys
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const wbBuf = readFileSync(join(ROOT, 'PGRecon_Working.xlsx'));
const wb = XLSX.read(wbBuf, { type: 'buffer', cellDates: false });

console.log('\n📋 Sheet names:', wb.SheetNames);

for (const name of wb.SheetNames) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
  if (rows.length === 0) { console.log(`\n[${name}] — empty`); continue; }
  console.log(`\n[${name}] — ${rows.length} rows — columns:`, Object.keys(rows[0]));
  console.log('  First row:', JSON.stringify(rows[0]).slice(0, 300));
}
