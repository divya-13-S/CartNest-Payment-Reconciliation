// scripts/audit-recon.mjs
// Deep audit of Payment Reconciliation calculations
// Run: node scripts/audit-recon.mjs

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const EXCEL_EPOCH_MS = new Date(Date.UTC(1899, 11, 30)).getTime();
function excelDate(v) {
  if (!v) return null;
  if (typeof v === 'number') return new Date(EXCEL_EPOCH_MS + v * 86400000);
  const s = String(v).trim();
  let d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  const m = s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (m) return new Date(+m[3], +m[2]-1, +m[1]);
  return null;
}
function dateFmt(d) {
  if (!d) return '';
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function num(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  const n = parseFloat(String(v).replace(/[₹,\s]/g,''));
  return isNaN(n) ? 0 : n;
}

// ── Normalise ID ──────────────────────────────────────────────────────────
// The key question: what does the workbook's Normalized_Order_ID look like
// vs what merchant_order_ref looks like?
function normIdStrict(id) {
  if (!id) return '';
  return String(id).trim().toUpperCase();
}

// ── Load workbook ──────────────────────────────────────────────────────────
console.log('═'.repeat(70));
console.log('CARTNEST PAYMENT RECONCILIATION — DEEP AUDIT');
console.log('═'.repeat(70));

const wb = XLSX.read(readFileSync(join(ROOT, 'PGRecon_Working.xlsx')), { type: 'buffer', cellDates: false });
console.log('\n📋 Sheet names:', wb.SheetNames);

function sheetRows(name) {
  const ws = wb.Sheets[name];
  if (!ws) { console.warn(`  ⚠ Sheet "${name}" not found`); return []; }
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

// ── ORDERS sheet ───────────────────────────────────────────────────────────
const ordersRaw = sheetRows('Orders');
console.log(`\n[Orders] ${ordersRaw.length} rows`);
console.log('  Columns:', Object.keys(ordersRaw[0]));
// Show first 3 rows to understand format
ordersRaw.slice(0,3).forEach((r,i) => {
  console.log(`  Row ${i+1}: don="${r.don}" order_date=${r.order_date} status="${r.order_status}" amount=${r.order_amount} Recon="${r.Reconciliation_Status}" NormID="${r.Normalized_Order_ID}" CaptureCount=${r.Capture_Count} CapturedAmt=${r.Captured_Amount} Variance=${r.Amount_Variance}`);
});

// ── PG_TRANSACTIONS sheet ──────────────────────────────────────────────────
const pgRaw = sheetRows('PG_Transactions');
console.log(`\n[PG_Transactions] ${pgRaw.length} rows`);
console.log('  Columns:', Object.keys(pgRaw[0]).slice(0, 12));
pgRaw.slice(0,3).forEach((r,i) => {
  console.log(`  Row ${i+1}: pg_txn_id="${r.pg_txn_id}" merchant_order_ref="${r.merchant_order_ref}" txn_type="${r.txn_type}" gross=${r.gross_amount} Norm_Ref="${r.Normalized_Order_Ref}" OrderMatch="${r.Order_Match_Check}" DupCount=${r.Duplicate_Count}`);
});

// ── BATCH_RECON sheet ──────────────────────────────────────────────────────
const batchRaw = sheetRows('Batch_Recon');
console.log(`\n[Batch_Recon] ${batchRaw.length} rows`);
console.log('  Columns:', Object.keys(batchRaw[0]));

// ════════════════════════════════════════════════════════════════════════════
// STEP 1: Understand the workbook's ID formats
// ════════════════════════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(70));
console.log('STEP 1: ID FORMAT ANALYSIS');
console.log('─'.repeat(70));

// Sample of order IDs from Orders sheet
const orderIdSamples = ordersRaw.slice(0,10).map(r => ({
  don: r.don, normalized: r.Normalized_Order_ID
}));
console.log('\nOrders sheet — "don" vs "Normalized_Order_ID" (first 10):');
orderIdSamples.forEach(s => console.log(`  don="${s.don}"  →  Norm="${s.normalized}"`));

// Sample of merchant_order_ref from PG_Transactions
const pgRefSamples = pgRaw.filter(r => r.txn_type === 'CAPTURE').slice(0,10).map(r => ({
  ref: r.merchant_order_ref, norm: r.Normalized_Order_Ref
}));
console.log('\nPG_Transactions — merchant_order_ref vs Normalized_Order_Ref (first 10 CAPTURE rows):');
pgRefSamples.forEach(s => console.log(`  ref="${s.ref}"  →  Norm="${s.norm}"`));

// ════════════════════════════════════════════════════════════════════════════
// STEP 2: Duplicate pg_txn_id analysis
// ════════════════════════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(70));
console.log('STEP 2: DUPLICATE pg_txn_id ANALYSIS');
console.log('─'.repeat(70));

const txnIdCount = {};
pgRaw.forEach(r => {
  const id = String(r.pg_txn_id || '').trim();
  if (!id) return;
  txnIdCount[id] = (txnIdCount[id] || 0) + 1;
});
const dupIds = Object.entries(txnIdCount).filter(([,c]) => c > 1);
console.log(`\nTotal PG rows: ${pgRaw.length}`);
console.log(`Distinct pg_txn_id values: ${Object.keys(txnIdCount).length}`);
console.log(`Duplicate pg_txn_ids (appear >1 time): ${dupIds.length}`);
console.log(`Rows involved in duplicates: ${dupIds.reduce((s,[,c])=>s+c,0)}`);
dupIds.slice(0,5).forEach(([id,c]) => {
  const rows = pgRaw.filter(r => String(r.pg_txn_id||'').trim() === id);
  console.log(`  "${id}" × ${c}  types: ${rows.map(r=>r.txn_type).join(',')}`);
});

// Dedup: keep first occurrence
const seenTxn = new Set();
const pgDeduped = pgRaw.filter(r => {
  const id = String(r.pg_txn_id||'').trim();
  if (!id) return false;
  if (seenTxn.has(id)) return false;
  seenTxn.add(id);
  return true;
});
const captures = pgDeduped.filter(r => String(r.txn_type||'').trim().toUpperCase() === 'CAPTURE');
const refunds  = pgDeduped.filter(r => String(r.txn_type||'').trim().toUpperCase() === 'REFUND');
console.log(`\nAfter dedup: ${pgDeduped.length} unique rows | ${captures.length} captures | ${refunds.length} refunds`);

// ════════════════════════════════════════════════════════════════════════════
// STEP 3: ID NORMALIZATION — what keys to match on
// ════════════════════════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(70));
console.log('STEP 3: NORMALIZATION STRATEGY TEST');
console.log('─'.repeat(70));

// Strategy A: use workbook's own Normalized_Order_ID / Normalized_Order_Ref
// Strategy B: trim + uppercase on don / merchant_order_ref
// Test both and see how many captures match orders

const ordersByNormA = {}; // key = workbook Normalized_Order_ID
const ordersByNormB = {}; // key = trim+upper of "don"
ordersRaw.forEach(r => {
  const keyA = String(r.Normalized_Order_ID || '').trim().toUpperCase();
  const keyB = String(r.don || '').trim().toUpperCase();
  if (keyA) ordersByNormA[keyA] = r;
  if (keyB) ordersByNormB[keyB] = r;
});

let matchA = 0, matchB = 0, noMatchA = 0, noMatchB = 0;
const orphansA = [], orphansB = [];
captures.forEach(c => {
  const refA = String(c.Normalized_Order_Ref || '').trim().toUpperCase();
  const refB = String(c.merchant_order_ref || '').trim().toUpperCase();
  if (ordersByNormA[refA]) matchA++; else { noMatchA++; orphansA.push({id:c.pg_txn_id,refA}); }
  if (ordersByNormB[refB]) matchB++; else { noMatchB++; orphansB.push({id:c.pg_txn_id,refB}); }
});
console.log(`\nStrategy A (workbook Normalized cols):  ${matchA} matched, ${noMatchA} unmatched (orphan captures)`);
console.log(`Strategy B (trim+upper raw fields):     ${matchB} matched, ${noMatchB} unmatched (orphan captures)`);

if (noMatchA <= 20) {
  console.log('\nOrphan captures (Strategy A):');
  orphansA.forEach(o => console.log(`  pg_txn_id="${o.id}" ref="${o.refA}"`));
}
if (noMatchB <= 20) {
  console.log('\nOrphan captures (Strategy B):');
  orphansB.forEach(o => console.log(`  pg_txn_id="${o.id}" ref="${o.refB}"`));
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 4: PAYMENT RECONCILIATION with correct normalization
// ════════════════════════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(70));
console.log('STEP 4: PAYMENT RECONCILIATION — CORRECT CALCULATION');
console.log('─'.repeat(70));

// Use Strategy B (trim+upper) since that matches reference figure of 8 orphans
// Build capture lookup by order ref
const capturesByOrderRef = {};
captures.forEach(c => {
  const ref = String(c.merchant_order_ref || '').trim().toUpperCase();
  if (!ref) return;
  if (!capturesByOrderRef[ref]) capturesByOrderRef[ref] = [];
  capturesByOrderRef[ref].push(c);
});

// All orders
const orders = ordersRaw.map(r => ({
  order_id:       String(r.don || '').trim().toUpperCase(),
  order_id_raw:   String(r.don || '').trim(),
  order_date:     dateFmt(excelDate(r.order_date)),
  payment_method: String(r.payment_method || '').trim(),
  order_amount:   num(r.order_amount),
  order_status:   String(r.order_status || '').trim(),
  // Workbook pre-calculated
  wb_recon_status:  String(r.Reconciliation_Status || '').trim(),
  wb_norm_id:       String(r.Normalized_Order_ID || '').trim().toUpperCase(),
  wb_capture_count: num(r.Capture_Count),
  wb_captured_amt:  num(r.Captured_Amount),
  wb_variance:      num(r.Amount_Variance),
})).filter(r => r.order_id);

const paidOrders = orders.filter(o => o.order_status === 'Paid');

// Compute reconciliation for PAID orders
const reconResults = paidOrders.map(ord => {
  const caps = capturesByOrderRef[ord.order_id] || [];
  const totalCap = caps.reduce((s,c) => s + num(c.gross_amount), 0);
  const variance = +(totalCap - ord.order_amount).toFixed(2);
  let status;
  if (caps.length === 0) status = 'no_capture';
  else if (caps.length > 1 && Math.abs(variance) < 0.01) status = 'matched_multi';
  else if (caps.length > 1) status = 'multi_capture_mismatch';
  else if (Math.abs(variance) < 0.01) status = 'matched';
  else status = 'amount_mismatch';
  return {
    order_id: ord.order_id,
    order_status: ord.order_status,
    payment_method: ord.payment_method,
    order_amount: ord.order_amount,
    capture_count: caps.length,
    total_captured: +totalCap.toFixed(2),
    variance,
    status,
    // Compare with workbook values
    wb_status: ord.wb_recon_status,
    wb_caps: ord.wb_capture_count,
    wb_captured: ord.wb_captured_amt,
  };
});

const matched          = reconResults.filter(r => r.status === 'matched');
const matchedMulti     = reconResults.filter(r => r.status === 'matched_multi');
const noCapture        = reconResults.filter(r => r.status === 'no_capture');
const amtMismatch      = reconResults.filter(r => r.status === 'amount_mismatch');
const multiCapMismatch = reconResults.filter(r => r.status === 'multi_capture_mismatch');
const multiCapAll      = reconResults.filter(r => r.capture_count > 1);

console.log(`\n── PAID Orders (${paidOrders.length}) ──`);
console.log(`  Matched (single cap, exact):          ${matched.length}`);
console.log(`  Matched (multi-cap, exact total):     ${matchedMulti.length}`);
console.log(`  No capture:                           ${noCapture.length}`);
console.log(`  Amount mismatch (single cap):         ${amtMismatch.length}`);
console.log(`  Multi-capture with mismatch:          ${multiCapMismatch.length}`);
console.log(`  All multi-capture orders:             ${multiCapAll.length}`);
console.log(`  Orphan captures (ref not in orders):  ${noMatchB}`);

// No-capture details
if (noCapture.length <= 30) {
  console.log('\nNo-capture paid orders:');
  noCapture.forEach(r => console.log(`  ${r.order_id}  amount=₹${r.order_amount}  wb_status="${r.wb_status}"`));
  console.log(`  Total amount: ₹${noCapture.reduce((s,r)=>s+r.order_amount,0).toFixed(2)}`);
}

// Amount mismatch details
if (amtMismatch.length <= 30) {
  console.log('\nAmount mismatch paid orders:');
  amtMismatch.forEach(r => console.log(`  ${r.order_id}  order=₹${r.order_amount}  captured=₹${r.total_captured}  variance=₹${r.variance}`));
  console.log(`  Total variance: ₹${amtMismatch.reduce((s,r)=>s+r.variance,0).toFixed(2)}`);
}

// Multi-capture details
console.log('\nMulti-capture orders:');
multiCapAll.forEach(r => console.log(`  ${r.order_id}  caps=${r.capture_count}  order=₹${r.order_amount}  captured=₹${r.total_captured}  variance=₹${r.variance}  status=${r.status}`));

// Orphan captures detail
console.log('\nOrphan capture transactions:');
orphansB.forEach(o => {
  const cap = captures.find(c => c.pg_txn_id === o.id);
  if (cap) console.log(`  ${o.id}  ref="${o.refB}"  gross=₹${cap.gross_amount}  method=${cap.payment_method}`);
});
console.log(`  Orphan gross total: ₹${orphansB.reduce((s,o)=>{
  const c = captures.find(cap=>cap.pg_txn_id===o.id);
  return s + (c ? num(c.gross_amount) : 0);
},0).toFixed(2)}`);

// ════════════════════════════════════════════════════════════════════════════
// STEP 5: ALL ORDERS (not just paid) reconciliation
// ════════════════════════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(70));
console.log('STEP 5: ALL-ORDERS RECONCILIATION');
console.log('─'.repeat(70));

const allRecon = orders.map(ord => {
  const caps = capturesByOrderRef[ord.order_id] || [];
  const totalCap = caps.reduce((s,c) => s + num(c.gross_amount), 0);
  const variance = +(totalCap - ord.order_amount).toFixed(2);
  let status;
  if (caps.length === 0) status = 'no_capture';
  else if (Math.abs(variance) < 0.01) status = 'matched';
  else status = 'amount_mismatch';
  return { order_id: ord.order_id, order_status: ord.order_status, caps: caps.length, variance, status };
});

const allMatched   = allRecon.filter(r => r.status === 'matched');
const allNoCapture = allRecon.filter(r => r.status === 'no_capture');
const allMismatch  = allRecon.filter(r => r.status === 'amount_mismatch');

console.log(`\nAll ${orders.length} orders:`);
console.log(`  Matched (captured = order amount):  ${allMatched.length}`);
console.log(`  No capture:                         ${allNoCapture.length}`);
console.log(`  Amount mismatch:                    ${allMismatch.length}`);
console.log(`  Multi-capture:                      ${allRecon.filter(r=>r.caps>1).length}`);

// ════════════════════════════════════════════════════════════════════════════
// STEP 6: WORKBOOK vs COMPUTED COMPARISON
// ════════════════════════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(70));
console.log('STEP 6: WORKBOOK vs COMPUTED');
console.log('─'.repeat(70));

// Workbook summary from Orders sheet (look for summary rows)
const wbMatchedRows = ordersRaw.filter(r => r.Reconciliation_Status === 'Amount Match');
const wbNoCaptureRows = ordersRaw.filter(r => r.Reconciliation_Status === 'No Capture');
const wbMismatchRows = ordersRaw.filter(r => r.Reconciliation_Status === 'Amount Mismatch');
const wbPaidRows = ordersRaw.filter(r => String(r.order_status||'').trim() === 'Paid');

console.log('\nWorkbook Reconciliation_Status counts (all 6000 order rows):');
console.log(`  Amount Match:    ${wbMatchedRows.length}`);
console.log(`  No Capture:      ${wbNoCaptureRows.length}`);
console.log(`  Amount Mismatch: ${wbMismatchRows.length}`);
console.log(`  (Paid orders):   ${wbPaidRows.length}`);

// Paid orders by workbook status
const wbPaidMatched   = wbPaidRows.filter(r => r.Reconciliation_Status === 'Amount Match');
const wbPaidNoCapture = wbPaidRows.filter(r => r.Reconciliation_Status === 'No Capture');
const wbPaidMismatch  = wbPaidRows.filter(r => r.Reconciliation_Status === 'Amount Mismatch');
console.log('\nWorkbook Reconciliation_Status for PAID orders only:');
console.log(`  Amount Match:    ${wbPaidMatched.length}`);
console.log(`  No Capture:      ${wbPaidNoCapture.length}`);
console.log(`  Amount Mismatch: ${wbPaidMismatch.length}`);

// Check if workbook Capture_Count > 1 for paid orders
const wbPaidMultiCap = wbPaidRows.filter(r => num(r.Capture_Count) > 1);
console.log(`  Multi-capture (Capture_Count > 1): ${wbPaidMultiCap.length}`);
wbPaidMultiCap.forEach(r => console.log(`    ${r.don}  Capture_Count=${r.Capture_Count}  CapturedAmt=${r.Captured_Amount}  order_amount=${r.order_amount}  status="${r.Reconciliation_Status}"`));

// ════════════════════════════════════════════════════════════════════════════
// STEP 7: REFERENCE vs COMPUTED VALIDATION TABLE
// ════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(70));
console.log('VALIDATION TABLE — REFERENCE vs COMPUTED');
console.log('═'.repeat(70));

const checks = [
  ['Total orders',               6000,   orders.length],
  ['Paid orders',                5255,   paidOrders.length],
  ['PG rows (raw)',              5752,   pgRaw.length],
  ['Raw capture rows',           5509,   pgRaw.filter(r=>r.txn_type==='CAPTURE').length],
  ['Refund rows',                243,    pgRaw.filter(r=>r.txn_type==='REFUND').length],
  ['Distinct duplicate tx IDs',  10,     dupIds.length],
  ['Rows in duplicates',         20,     dupIds.reduce((s,[,c])=>s+c,0)],
  ['Unique IDs after dedup',     5742,   pgDeduped.length],
  ['All-order matched (all status)', 5464, allMatched.length],
  ['All-order no capture',        515,    allNoCapture.length],
  ['Paid no capture',             20,     noCapture.length],
  ['Multi-capture (paid)',        6,      multiCapAll.length],
  ['Amount mismatch single-cap',  15,     amtMismatch.length],
  ['Orphan captures',             8,      orphansB.length],
];

checks.forEach(([label, ref, computed]) => {
  const ok = ref === computed ? '✅ PASS' : '❌ FAIL';
  const diff = computed - ref;
  console.log(`  ${ok}  ${label.padEnd(35)} ref=${String(ref).padStart(6)}  computed=${String(computed).padStart(6)}  diff=${diff >= 0 ? '+' : ''}${diff}`);
});

// ════════════════════════════════════════════════════════════════════════════
// STEP 8: WHY CURRENT DASHBOARD SHOWS WRONG NUMBERS
// ════════════════════════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(70));
console.log('STEP 8: ROOT CAUSE ANALYSIS');
console.log('─'.repeat(70));

// Test: what does normId(r.merchant_order_ref) do?
// The old prepare-data script uses: normId(r.merchant_order_ref || r.Normalized_Order_Ref || '')
// normId = toUpperCase().trim().replace(/\s+/g,'')
// orders uses: normId(r.don || r.order_id)
// The issue may be that r.Normalized_Order_Ref was used as a fallback

const pgWithNormRef = pgRaw.slice(0,5).filter(r=>r.txn_type==='CAPTURE');
console.log('\nFirst 5 capture rows — key ref columns:');
pgWithNormRef.forEach(r => {
  const merchantRef = String(r.merchant_order_ref||'').trim().toUpperCase();
  const normRef = String(r.Normalized_Order_Ref||'').trim().toUpperCase();
  console.log(`  merchant_order_ref="${merchantRef}" | Normalized_Order_Ref="${normRef}" | match_in_orders_by_merchant=${!!ordersByNormB[merchantRef]} | match_by_norm=${!!ordersByNormB[normRef]}`);
});

// Check what the current dashboard's capturesByOrder lookup key is
// prepare-data.mjs uses: order_ref: normId(r.merchant_order_ref || r.Normalized_Order_Ref || '')
// If merchant_order_ref is empty and Normalized_Order_Ref has a different format, that could cause mismatches
const emptyMerchantRef = pgRaw.filter(r => r.txn_type==='CAPTURE' && !String(r.merchant_order_ref||'').trim());
console.log(`\nCapture rows with empty merchant_order_ref: ${emptyMerchantRef.length}`);

// Summary of no_capture paid orders from workbook
console.log('\nWorkbook No-Capture paid orders (Reconciliation_Status):');
wbPaidNoCapture.slice(0,25).forEach(r => {
  console.log(`  ${r.don}  amount=₹${r.order_amount}  wb_capture_count=${r.Capture_Count}`);
});
console.log(`  Total amount: ₹${wbPaidNoCapture.reduce((s,r)=>s+num(r.order_amount),0).toFixed(2)}`);
