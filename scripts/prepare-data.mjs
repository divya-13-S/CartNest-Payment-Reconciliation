// scripts/prepare-data.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Reads PGRecon_Working.xlsx and writes public/data/dashboard-data.json
// Run:  npm run prepare-data
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Helpers ────────────────────────────────────────────────────────────────

function parseNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  const s = String(v).replace(/[₹,\s]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function normId(id) {
  if (!id) return '';
  // Strip hyphens and spaces so ORD-26000130 === ORD26000130
  return String(id).trim().toUpperCase().replace(/[-\s]/g, '');
}

// Excel epoch is 30 Dec 1899 (accounting for the Lotus 1-2-3 leap-year bug)
const EXCEL_EPOCH_MS = new Date(Date.UTC(1899, 11, 30)).getTime();

function parseDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const d = new Date(EXCEL_EPOCH_MS + v * 86400000);
    if (!isNaN(d.getTime())) return d;
  }
  const s = String(v).trim();
  // ISO  YYYY-MM-DD  or  full ISO timestamp
  let d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  // DD-MM-YYYY  or  DD/MM/YYYY
  const m1 = s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (m1) return new Date(+m1[3], +m1[2] - 1, +m1[1]);
  // YYYY-MM-DD (explicit, no time)
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) return new Date(+m2[1], +m2[2] - 1, +m2[3]);
  return null;
}

function dateFmt(d) {
  if (!d) return '';
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}

function getMDRRate(rateCard, method, amount) {
  if (!rateCard || !rateCard.length) return { mdrPct: 0, gstPct: 0.18 };
  const rows = rateCard.filter(r =>
    String(r.payment_method || '').trim().toLowerCase() === String(method || '').trim().toLowerCase()
  );
  if (!rows.length) return { mdrPct: 0, gstPct: 0.18 };
  const amt = parseNum(amount);
  let matched = rows[0];
  for (const row of rows) {
    const lo   = parseNum(row.amount_above ?? 0);
    const hiRaw = row.amount_up_to;
    const hi   = (hiRaw === '' || hiRaw == null) ? Infinity : parseNum(hiRaw);
    if (amt > lo && amt <= hi) { matched = row; break; }
  }
  return {
    mdrPct: parseNum(matched.mdr_pct) / 100,
    gstPct: parseNum(matched.gst_on_mdr_pct) / 100,
  };
}

const BANK_CUTOFF = new Date('2026-09-30T23:59:59');

// ── Load workbook ──────────────────────────────────────────────────────────

const wbPath = join(ROOT, 'PGRecon_Working.xlsx');
console.log(`📂  Reading: ${wbPath}`);
const wb = XLSX.read(readFileSync(wbPath), { type: 'buffer', cellDates: false });

function sheet(name) {
  const ws = wb.Sheets[name];
  if (!ws) { console.warn(`  ⚠  Sheet "${name}" not found`); return []; }
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

// NOTE: Orders sheet uses "don" for the order_id column (checked via inspection)
const ordersRaw  = sheet('Orders');
const pgRaw      = sheet('PG_Transactions');
const bankRaw    = sheet('Bank_Statement');
const batchRaw   = sheet('Batch_Recon');
const mdrRaw     = sheet('MDR_Rates');

console.log(`   Orders: ${ordersRaw.length} | PG txns: ${pgRaw.length} | Bank: ${bankRaw.length} | Batch_Recon: ${batchRaw.length} | MDR: ${mdrRaw.length}`);

const rateCard = mdrRaw;

// ── Normalise Orders ───────────────────────────────────────────────────────
// The workbook uses "don" as the order_id column name in the Orders sheet

const orders = ordersRaw.map(r => ({
  // 'don' is the actual column heading for order_id in this workbook
  order_id:       normId(r.don || r.order_id),
  order_date:     dateFmt(parseDate(r.order_date)),
  customer_id:    String(r.customer_id || '').trim(),
  city:           String(r.city || '').trim(),
  payment_method: String(r.payment_method || '').trim(),
  order_amount:   parseNum(r.order_amount),
  order_status:   String(r.order_status || '').trim(),
  // Use pre-calculated helper columns where available
  recon_status:   String(r.Reconciliation_Status || '').trim(),
  capture_count:  parseNum(r.Capture_Count),
  captured_amount: parseNum(r.Captured_Amount),
  amount_variance: parseNum(r.Amount_Variance),
})).filter(r => r.order_id);

const paidOrders = orders.filter(r => r.order_status === 'Paid');
console.log(`   Total orders: ${orders.length} | Paid: ${paidOrders.length}`);

// ── Normalise PG Transactions (deduplicate by pg_txn_id) ──────────────────
// KEY FIX: Use workbook's Normalized_Order_Ref as the primary matching key.
// Some merchant_order_refs contain hyphens (ORD-26000130) while order IDs do not (ORD26000130).
// The workbook's Normalized_Order_Ref column already strips these hyphens.
// Falling back to normId(merchant_order_ref) would strip hyphens too, but the workbook
// column is the authoritative normalized form and must be preferred.

const seenTxn = new Set();
const pgAll = pgRaw.map(r => {
  // Prefer workbook's normalized ref; fall back to stripping hyphens ourselves
  const normRef = String(r.Normalized_Order_Ref || '').trim().toUpperCase();
  const rawRef  = normId(r.merchant_order_ref || '');  // normId now strips hyphens
  const order_ref = normRef || rawRef;
  return {
    pg_txn_id:           String(r.pg_txn_id || '').trim(),
    original_payment_id: String(r.original_payment_id || '').trim(),
    order_ref,
    merchant_order_ref_raw: String(r.merchant_order_ref || '').trim(), // kept for audit
    txn_date:            dateFmt(parseDate(r.txn_date)),
    txn_type:            String(r.txn_type || '').trim().toUpperCase(),
    payment_method:      String(r.payment_method || '').trim(),
    gross_amount:        parseNum(r.gross_amount),
    mdr_fee:             parseNum(r.mdr_fee),
    gst_on_fee:          parseNum(r.gst_on_fee),
    net_amount:          parseNum(r.net_amount),
    settlement_date:     dateFmt(parseDate(r.settlement_date)),
    settlement_batch_id: String(r.settlement_batch_id || '').trim(),
    // Helper columns from workbook
    expected_mdr_pct:    parseNum(r.Expected_MDR_Pct),
    expected_mdr_fee:    parseNum(r.Expected_MDR_Fee),
    expected_gst:        parseNum(r.Expected_GST),
    mdr_variance:        parseNum(r.MDR_Fee_Variance),
    gst_variance:        parseNum(r.GST_Variance),
    txn_category:        String(r.Transaction_Category || '').trim(),
  };
}).filter(r => {
  if (!r.pg_txn_id) return false;
  if (seenTxn.has(r.pg_txn_id)) return false;
  seenTxn.add(r.pg_txn_id);
  return true;
});

const captures = pgAll.filter(r => r.txn_type === 'CAPTURE');
const refunds  = pgAll.filter(r => r.txn_type === 'REFUND');
console.log(`   Unique captures: ${captures.length} | Unique refunds: ${refunds.length}`);

// ── Normalise Bank Statement ───────────────────────────────────────────────

const bankEntries = bankRaw.map(r => ({
  value_date:  dateFmt(parseDate(r.value_date)),
  narration:   String(r.narration || '').trim(),
  utr:         String(r.utr || '').trim(),
  debit:       parseNum(r.debit),
  credit:      parseNum(r.credit),
  category:    String(r.Transaction_Category || '').trim(),
})).filter(r => r.value_date);

const bankGwCredits = bankEntries.filter(r =>
  r.credit > 0 && /STL-\d{8}/i.test(r.narration)
).map(r => {
  const m = r.narration.match(/STL-\d{8}/i);
  return { ...r, batch_id: m ? m[0].toUpperCase() : '' };
});

// ── KPIs ──────────────────────────────────────────────────────────────────

const totalOrderValue        = orders.reduce((s, r) => s + r.order_amount, 0);
const paidOrderValue         = paidOrders.reduce((s, r) => s + r.order_amount, 0);
const gatewayCaptureAmount   = captures.reduce((s, r) => s + r.gross_amount, 0);
const totalRefundsAmount     = refunds.reduce((s, r) => s + r.gross_amount, 0);
const actualBankCredits      = bankGwCredits.reduce((s, r) => s + r.credit, 0);
const totalCaptureNet        = captures.reduce((s, r) => s + r.net_amount, 0);
const expectedNetSettlements = totalCaptureNet - totalRefundsAmount;

// Prefer workbook's pre-calculated fee fields where available
const actualMDR = captures.reduce((s, r) => s + r.mdr_fee, 0);
const actualGST = captures.reduce((s, r) => s + r.gst_on_fee, 0);

const expectedMDR_GST = captures.reduce((s, r) => {
  // Use pre-calculated from workbook if present, otherwise recalculate
  if (r.expected_mdr_fee !== 0 || r.expected_gst !== 0) {
    return s + r.expected_mdr_fee + r.expected_gst;
  }
  const { mdrPct, gstPct } = getMDRRate(rateCard, r.payment_method, r.gross_amount);
  const mdr = r.gross_amount * mdrPct;
  return s + mdr + mdr * gstPct;
}, 0);

const feeVariance = (actualMDR + actualGST) - expectedMDR_GST;

// ── Payment Reconciliation ────────────────────────────────────────────────
// Matching uses the workbook's Normalized_Order_Ref (hyphens already stripped).
// reconResults covers PAID orders only (status = 'Paid').
// Orphan captures = captures whose order_ref matches NO order (any status).

const capturesByOrder = {};
for (const cap of captures) {
  const oid = cap.order_ref;
  if (!oid) continue;
  if (!capturesByOrder[oid]) capturesByOrder[oid] = [];
  capturesByOrder[oid].push(cap);
}

// All order IDs (any status) — used for orphan detection
const allOrderIds  = new Set(orders.map(o => o.order_id));
const paidOrderIds = new Set(paidOrders.map(o => o.order_id));

// Build a quick order lookup
const orderById = {};
orders.forEach(o => { orderById[o.order_id] = o; });

const reconResults = paidOrders.map(ord => {
  const caps     = capturesByOrder[ord.order_id] || [];
  const totalCap = caps.reduce((s, c) => s + c.gross_amount, 0);
  const amtDiff  = totalCap - ord.order_amount;

  // Prefer the workbook's Reconciliation_Status if available.
  // Multi-capture orders are shown as 'Multiple Capture Rows - Review' in the workbook.
  let status;
  const wbStatus = ord.recon_status;
  if (wbStatus === 'Amount Match')                      status = 'matched';
  else if (wbStatus === 'No Capture')                   status = 'no_capture';
  else if (wbStatus === 'Amount Mismatch')              status = 'amount_mismatch';
  else if (wbStatus === 'Multiple Capture Rows - Review') status = 'multi_capture';
  else {
    // Computed fallback
    if (caps.length === 0)              status = 'no_capture';
    else if (caps.length > 1)          status = 'multi_capture';
    else if (Math.abs(amtDiff) < 0.01) status = 'matched';
    else                               status = 'amount_mismatch';
  }

  return {
    order_id:       ord.order_id,
    order_date:     ord.order_date,
    order_status:   ord.order_status,
    payment_method: ord.payment_method,
    order_amount:   ord.order_amount,
    capture_amount: +totalCap.toFixed(2),
    capture_count:  caps.length,
    status,
    variance:       +amtDiff.toFixed(2),
  };
});

// CORRECT definition: orphan = capture whose order_ref matches NO order (any status)
const orphanCaptures = captures.filter(c => c.order_ref && !allOrderIds.has(c.order_ref));

const matchedCount         = reconResults.filter(r => r.status === 'matched').length;
const noCaptureCount       = reconResults.filter(r => r.status === 'no_capture').length;
const amtMismatchCount     = reconResults.filter(r => r.status === 'amount_mismatch').length;
const multiCaptureOrders   = reconResults.filter(r => r.status === 'multi_capture');
const multiCaptureCount    = multiCaptureOrders.length;

console.log(`   Matched: ${matchedCount} | No Capture: ${noCaptureCount} | Mismatch: ${amtMismatchCount} | Multi-capture: ${multiCaptureCount} | Orphans: ${orphanCaptures.length}`);

const reconChartData = [
  { name: 'Matched',         count: matchedCount,           value: +(reconResults.filter(r=>r.status==='matched').reduce((s,r)=>s+r.order_amount,0)).toFixed(2),              color: '#71866A' },
  { name: 'No Capture',      count: noCaptureCount,         value: +(reconResults.filter(r=>r.status==='no_capture').reduce((s,r)=>s+r.order_amount,0)).toFixed(2),           color: '#C9856B' },
  { name: 'Amt Mismatch',    count: amtMismatchCount,       value: +(reconResults.filter(r=>r.status==='amount_mismatch').reduce((s,r)=>s+Math.abs(r.variance),0)).toFixed(2), color: '#6F9990' },
  { name: 'Multi-Capture',   count: multiCaptureCount,      value: +(multiCaptureOrders.reduce((s,r)=>s+r.order_amount,0)).toFixed(2),                                        color: '#9B8EC4' },
  { name: 'Orphan Captures', count: orphanCaptures.length,  value: +(orphanCaptures.reduce((s,c)=>s+c.gross_amount,0)).toFixed(2),                                            color: '#D4A96A' },
];

// ── Fee Analysis ──────────────────────────────────────────────────────────

const feeByMethod = {};
for (const cap of captures) {
  const pm = cap.payment_method || 'Unknown';
  if (!feeByMethod[pm]) feeByMethod[pm] = { method: pm, actualMDR: 0, actualGST: 0, expectedMDR: 0, expectedGST: 0 };
  feeByMethod[pm].actualMDR += cap.mdr_fee;
  feeByMethod[pm].actualGST += cap.gst_on_fee;
  if (cap.expected_mdr_fee !== 0 || cap.expected_gst !== 0) {
    feeByMethod[pm].expectedMDR += cap.expected_mdr_fee;
    feeByMethod[pm].expectedGST += cap.expected_gst;
  } else {
    const { mdrPct, gstPct } = getMDRRate(rateCard, pm, cap.gross_amount);
    const expMdr = cap.gross_amount * mdrPct;
    feeByMethod[pm].expectedMDR += expMdr;
    feeByMethod[pm].expectedGST += expMdr * gstPct;
  }
}

const feeChartData = Object.values(feeByMethod).map(d => ({
  method:      d.method,
  actualFee:   +(d.actualMDR + d.actualGST).toFixed(2),
  expectedFee: +(d.expectedMDR + d.expectedGST).toFixed(2),
  variance:    +((d.actualMDR + d.actualGST) - (d.expectedMDR + d.expectedGST)).toFixed(2),
}));

// Fee exceptions — prefer workbook's MDR_Fee_Variance + GST_Variance if available
const feeExceptions = captures.filter(cap => {
  if (cap.mdr_variance !== 0 || cap.gst_variance !== 0) {
    return Math.abs(cap.mdr_variance + cap.gst_variance) > 1;
  }
  const { mdrPct, gstPct } = getMDRRate(rateCard, cap.payment_method, cap.gross_amount);
  const expMdr = cap.gross_amount * mdrPct;
  return Math.abs((cap.mdr_fee + cap.gst_on_fee) - (expMdr + expMdr * gstPct)) > 1;
}).map(cap => {
  let expFee, actFee;
  if (cap.expected_mdr_fee !== 0 || cap.expected_gst !== 0) {
    expFee = +(cap.expected_mdr_fee + cap.expected_gst).toFixed(2);
  } else {
    const { mdrPct, gstPct } = getMDRRate(rateCard, cap.payment_method, cap.gross_amount);
    const expMdr = cap.gross_amount * mdrPct;
    expFee = +(expMdr + expMdr * gstPct).toFixed(2);
  }
  actFee = +(cap.mdr_fee + cap.gst_on_fee).toFixed(2);
  return {
    pg_txn_id:        cap.pg_txn_id,
    order_ref:        cap.order_ref,
    payment_method:   cap.payment_method,
    gross_amount:     cap.gross_amount,
    expected_fee:     expFee,
    actual_fee:       actFee,
    variance:         +(actFee - expFee).toFixed(2),
    settlement_batch: cap.settlement_batch_id,
  };
});

// ── Settlement Reconciliation (prefer Batch_Recon sheet) ─────────────────

let settlementData;

if (batchRaw.length > 0) {
  // Use pre-calculated values from workbook's Batch_Recon sheet
  settlementData = batchRaw.map(r => {
    const bid      = String(r.settlement_batch_id || '').trim();
    const expected = parseNum(r.Expected_Gateway_Net);
    const actual   = parseNum(r.Actual_Bank_Credit);
    const variance = +(actual - expected).toFixed(2);

    // Determine settlement date from PG data
    const batchCaps = captures.filter(c => c.settlement_batch_id === bid);
    const settlDate = batchCaps.length ? parseDate(batchCaps[0].settlement_date) : null;

    let status;
    const isOutsidePeriod = settlDate && settlDate > BANK_CUTOFF;
    if (isOutsidePeriod)     status = 'outside_period';
    else if (actual === 0)   status = 'missing';
    else if (Math.abs(variance) < 1) status = 'matched';
    else                     status = 'short_paid';

    // Override with workbook's Settlement_Status if definitive
    const wbStatus = String(r.Settlement_Status || '').trim();
    if (wbStatus === 'Matched' && !isOutsidePeriod) status = 'matched';
    if (wbStatus === 'Short-paid')                  status = 'short_paid';
    if (wbStatus === 'Missing')                     status = 'missing';

    return {
      batch_id:        bid,
      settlement_date: batchCaps.length ? batchCaps[0].settlement_date : '',
      expected:        +expected.toFixed(2),
      actual:          +actual.toFixed(2),
      variance:        +variance.toFixed(2),
      status,
      tx_count:        batchCaps.filter(c => c.txn_type === 'CAPTURE').length,
      refund_count:    refunds.filter(r => r.settlement_batch_id === bid).length,
    };
  }).filter(r => r.batch_id).sort((a, b) => a.batch_id.localeCompare(b.batch_id));
} else {
  // Fallback: compute from raw data
  const batchCapMap = {};
  for (const cap of captures) {
    const bid = cap.settlement_batch_id;
    if (!bid) continue;
    if (!batchCapMap[bid]) batchCapMap[bid] = { caps: [], refunds: [], date: cap.settlement_date };
    batchCapMap[bid].caps.push(cap);
  }
  for (const ref of refunds) {
    const bid = ref.settlement_batch_id;
    if (!bid) continue;
    if (!batchCapMap[bid]) batchCapMap[bid] = { caps: [], refunds: [], date: ref.settlement_date };
    batchCapMap[bid].refunds.push(ref);
  }
  const bankByBatch = {};
  for (const bc of bankGwCredits) bankByBatch[bc.batch_id] = bc.credit;

  settlementData = Object.entries(batchCapMap).map(([bid, data]) => {
    const capNet   = data.caps.reduce((s, c) => s + c.net_amount, 0);
    const refAmt   = data.refunds.reduce((s, r) => s + r.gross_amount, 0);
    const expected = +(capNet - refAmt).toFixed(2);
    const actual   = +(bankByBatch[bid] || 0).toFixed(2);
    const variance = +(actual - expected).toFixed(2);
    const settlDate = data.date ? parseDate(data.date) : null;
    let status;
    if (settlDate && settlDate > BANK_CUTOFF) status = 'outside_period';
    else if (!bankByBatch[bid])               status = 'missing';
    else if (Math.abs(variance) < 1)          status = 'matched';
    else                                       status = 'short_paid';
    return {
      batch_id:        bid,
      settlement_date: data.date || '',
      expected, actual, variance, status,
      tx_count:     data.caps.length,
      refund_count: data.refunds.length,
    };
  }).sort((a, b) => a.batch_id.localeCompare(b.batch_id));
}

const settlementChartData = settlementData.slice(0, 30).map(d => ({
  batch:    d.batch_id.replace('STL-', ''),
  expected: d.expected,
  actual:   d.actual,
  status:   d.status,
}));

// ── Exceptions ────────────────────────────────────────────────────────────
// Each exception row now carries order_status and captured_amount for full traceability.

const exceptions = [];

// 1. Paid orders with no gateway capture
reconResults.filter(r => r.status === 'no_capture').forEach(r => {
  exceptions.push({
    category:         'No Gateway Capture',
    order_id:         r.order_id,
    pg_txn_id:        '—',
    order_status:     r.order_status,
    payment_method:   r.payment_method,
    txn_type:         'CAPTURE',
    order_amount:     r.order_amount,
    captured_amount:  0,
    gross_amount:     r.order_amount,
    expected_fee:     null,
    actual_fee:       null,
    settlement_batch: '—',
    variance:         +(-r.order_amount).toFixed(2),
    action:           'Investigate missing capture record',
  });
});

// 2. Paid orders with a single-capture amount mismatch (shortfall)
reconResults.filter(r => r.status === 'amount_mismatch').forEach(r => {
  const caps = capturesByOrder[r.order_id] || [];
  const capIds = caps.map(c => c.pg_txn_id).join(', ');
  exceptions.push({
    category:         'Amount Mismatch',
    order_id:         r.order_id,
    pg_txn_id:        capIds || '—',
    order_status:     r.order_status,
    payment_method:   r.payment_method,
    txn_type:         'CAPTURE',
    order_amount:     r.order_amount,
    captured_amount:  r.capture_amount,
    gross_amount:     r.order_amount,
    expected_fee:     null,
    actual_fee:       null,
    settlement_batch: caps.length ? caps[0].settlement_batch_id : '—',
    variance:         r.variance,
    action:           'Reconcile capture vs order amount',
  });
});

// 3. Paid orders with multiple captures (require manual review)
reconResults.filter(r => r.status === 'multi_capture').forEach(r => {
  const caps = capturesByOrder[r.order_id] || [];
  const capIds = caps.map(c => c.pg_txn_id).join(', ');
  exceptions.push({
    category:         'Multi-Capture — Review',
    order_id:         r.order_id,
    pg_txn_id:        capIds,
    order_status:     r.order_status,
    payment_method:   r.payment_method,
    txn_type:         'CAPTURE',
    order_amount:     r.order_amount,
    captured_amount:  r.capture_amount,
    gross_amount:     r.order_amount,
    expected_fee:     null,
    actual_fee:       null,
    settlement_batch: caps.length ? caps[0].settlement_batch_id : '—',
    variance:         r.variance,
    action:           'Verify whether both captures are legitimate',
  });
});

// 4. Orphan captures — ref matches no order at all
orphanCaptures.slice(0, 50).forEach(cap => {
  exceptions.push({
    category:         'Unmatched Capture',
    order_id:         cap.merchant_order_ref_raw || cap.order_ref || '—',
    pg_txn_id:        cap.pg_txn_id,
    order_status:     '—',
    payment_method:   cap.payment_method,
    txn_type:         'CAPTURE',
    order_amount:     0,
    captured_amount:  cap.gross_amount,
    gross_amount:     cap.gross_amount,
    expected_fee:     null,
    actual_fee:       null,
    settlement_batch: cap.settlement_batch_id,
    variance:         cap.gross_amount,
    action:           'Check order reference — no matching order found',
  });
});

// 5. Fee exceptions
feeExceptions.slice(0, 50).forEach(fe => {
  const ord = orderById[fe.order_ref];
  exceptions.push({
    category:         'Fee Variance',
    order_id:         fe.order_ref || '—',
    pg_txn_id:        fe.pg_txn_id,
    order_status:     ord ? ord.order_status : '—',
    payment_method:   fe.payment_method,
    txn_type:         'CAPTURE',
    order_amount:     ord ? ord.order_amount : 0,
    captured_amount:  fe.gross_amount,
    gross_amount:     fe.gross_amount,
    expected_fee:     fe.expected_fee,
    actual_fee:       fe.actual_fee,
    settlement_batch: fe.settlement_batch,
    variance:         fe.variance,
    action:           fe.variance > 0 ? 'Overcharged — request credit note' : 'Undercharged — verify rate',
  });
});

// 6. Settlement issues
settlementData.filter(r => r.status === 'missing' || r.status === 'short_paid').forEach(r => {
  exceptions.push({
    category:         r.status === 'missing' ? 'Missing Settlement' : 'Short Settlement',
    order_id:         '—',
    pg_txn_id:        '—',
    order_status:     '—',
    payment_method:   '—',
    txn_type:         'SETTLEMENT',
    order_amount:     r.expected,
    captured_amount:  r.actual,
    gross_amount:     r.expected,
    expected_fee:     null,
    actual_fee:       null,
    settlement_batch: r.batch_id,
    variance:         r.variance,
    action:           r.status === 'missing' ? 'Raise query with gateway' : 'Reconcile short payment with gateway',
  });
});

const potentialExceptions =
  feeExceptions.reduce((s, e) => s + Math.abs(e.variance), 0) +
  settlementData.filter(r => r.status === 'short_paid').reduce((s, r) => s + Math.abs(r.variance), 0);

// ── Build and write JSON ───────────────────────────────────────────────────

const output = {
  generatedAt: new Date().toISOString(),
  kpis: {
    totalOrderValue:       +totalOrderValue.toFixed(2),
    paidOrderValue:        +paidOrderValue.toFixed(2),
    gatewayCaptureAmount:  +gatewayCaptureAmount.toFixed(2),
    totalRefundsAmount:    +totalRefundsAmount.toFixed(2),
    actualBankCredits:     +actualBankCredits.toFixed(2),
    expectedNetSettlements: +expectedNetSettlements.toFixed(2),
    feeVariance:           +feeVariance.toFixed(2),
    potentialExceptions:   +potentialExceptions.toFixed(2),
    orderCount:            orders.length,
    paidOrderCount:        paidOrders.length,
    captureCount:          captures.length,
    refundCount:           refunds.length,
  },
  actualMDR:       +actualMDR.toFixed(2),
  actualGST:       +actualGST.toFixed(2),
  expectedMDR_GST: +expectedMDR_GST.toFixed(2),
  reconChartData,
  feeChartData,
  settlementChartData,
  settlementData,
  reconResults:    reconResults,              // all 5255 paid orders — needed for correct filtered counts
  feeExceptions:   feeExceptions.slice(0, 200),
  exceptions:      exceptions.slice(0, 500),
  paymentMethods:   [...new Set(captures.map(c => c.payment_method).filter(Boolean))].sort(),
  matchedCount,
  noCaptureCount,
  amtMismatchCount,
  orphanCount:       orphanCaptures.length,
  multiCaptureCount,
  // Orphan details for validation
  orphanGrossTotal:  +orphanCaptures.reduce((s,c) => s + c.gross_amount, 0).toFixed(2),
  noCaptureAmount:   +reconResults.filter(r=>r.status==='no_capture').reduce((s,r)=>s+r.order_amount,0).toFixed(2),
};

const outDir  = join(ROOT, 'public', 'data');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'dashboard-data.json');
writeFileSync(outPath, JSON.stringify(output));
const kb = (readFileSync(outPath).length / 1024).toFixed(1);

console.log(`\n✅  Wrote ${outPath} (${kb} KB)\n`);
console.log(`📊  Key Metrics:`);
console.log(`    Total Order Value:     ₹${output.kpis.totalOrderValue.toLocaleString('en-IN', {minimumFractionDigits:2})}`);
console.log(`    Paid Order Value:      ₹${output.kpis.paidOrderValue.toLocaleString('en-IN', {minimumFractionDigits:2})}`);
console.log(`    Gateway Captures:      ₹${output.kpis.gatewayCaptureAmount.toLocaleString('en-IN', {minimumFractionDigits:2})}`);
console.log(`    Total Refunds:         ₹${output.kpis.totalRefundsAmount.toLocaleString('en-IN', {minimumFractionDigits:2})}`);
console.log(`    Actual Bank Credits:   ₹${output.kpis.actualBankCredits.toLocaleString('en-IN', {minimumFractionDigits:2})}`);
console.log(`    Expected Net Settle:   ₹${output.kpis.expectedNetSettlements.toLocaleString('en-IN', {minimumFractionDigits:2})}`);
console.log(`    Fee Variance:          ₹${output.kpis.feeVariance.toLocaleString('en-IN', {minimumFractionDigits:2})}`);
console.log(`    Potential Exceptions:  ₹${output.kpis.potentialExceptions.toLocaleString('en-IN', {minimumFractionDigits:2})}`);
console.log(`    Orders:  ${output.kpis.orderCount} total | ${output.kpis.paidOrderCount} paid`);
console.log(`    Recon:   ${matchedCount} matched | ${noCaptureCount} no-capture | ${amtMismatchCount} mismatch`);
console.log(`    Settlements: ${settlementData.filter(s=>s.status==='matched').length} matched | ${settlementData.filter(s=>s.status==='short_paid').length} short | ${settlementData.filter(s=>s.status==='missing').length} missing | ${settlementData.filter(s=>s.status==='outside_period').length} outside period`);
console.log(`    Exceptions:  ${exceptions.length} total\n`);
console.log(`🚀  Now run: npm run dev  →  http://localhost:5173\n`);
