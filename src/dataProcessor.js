// ─── dataProcessor.js ───────────────────────────────────────────────────────
// Reads SheetJS workbook data and computes all metrics for the dashboard.
// The CSV files are used as fallback if workbook sheets are unavailable.

import * as XLSX from 'xlsx';

/** Format number as Indian currency (e.g. ₹1,23,456.78) */
export function fmtINR(num) {
  if (num == null || isNaN(num)) return '₹—';
  const n = Math.abs(Number(num));
  const sign = Number(num) < 0 ? '-' : '';
  const parts = n.toFixed(2).split('.');
  let intPart = parts[0];
  const dec = parts[1];
  if (intPart.length > 3) {
    const last3 = intPart.slice(-3);
    const rest = intPart.slice(0, -3);
    intPart = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }
  return `${sign}₹${intPart}.${dec}`;
}

/** Parse a possibly-messy numeric string / Excel serial */
function parseNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[₹,\s]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/** Normalise an order-ID to upper-case, strip extra spaces */
function normId(id) {
  if (!id) return '';
  return String(id).trim().toUpperCase().replace(/\s+/g, '');
}

/** Parse various date formats into a Date object */
function parseDate(v) {
  if (!v) return null;
  if (typeof v === 'number') {
    // Excel serial date
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return new Date(d.y, d.m - 1, d.d);
  }
  const s = String(v).trim();
  // Try ISO first
  let d = new Date(s);
  if (!isNaN(d)) return d;
  // DD-MM-YYYY or DD/MM/YYYY
  const m1 = s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (m1) return new Date(+m1[3], +m1[2] - 1, +m1[1]);
  // YYYY-MM-DD
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) return new Date(+m2[1], +m2[2] - 1, +m2[3]);
  return null;
}

function dateFmt(d) {
  if (!d) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * Given an MDR rate card array, return { mdrPct, gstPct } for a payment method
 * and gross amount.
 */
function getMDRRate(rateCard, method, amount) {
  if (!rateCard || !rateCard.length) return { mdrPct: 0, gstPct: 0.18 };
  const rows = rateCard.filter(r => {
    const pm = String(r.payment_method || r['payment_method'] || '').trim();
    return pm.toLowerCase() === String(method || '').toLowerCase();
  });
  if (!rows.length) return { mdrPct: 0, gstPct: 0.18 };
  const amt = Number(amount) || 0;
  let matched = rows[0];
  for (const row of rows) {
    const lo = parseNum(row.amount_above ?? row['amount_above'] ?? 0);
    const hiRaw = row.amount_up_to ?? row['amount_up_to'];
    const hi = hiRaw === '' || hiRaw == null ? Infinity : parseNum(hiRaw);
    if (amt > lo && amt <= hi) { matched = row; break; }
  }
  const mdrPct = parseNum(matched.mdr_pct ?? matched['mdr_pct']) / 100;
  const gstPct = parseNum(matched.gst_on_mdr_pct ?? matched['gst_on_mdr_pct']) / 100;
  return { mdrPct, gstPct };
}

/** Bank statement cutoff */
const BANK_CUTOFF = new Date('2026-09-30T23:59:59');

// ─── MAIN PROCESSOR ──────────────────────────────────────────────────────────

export function processWorkbook(wb) {
  // --- helper to read sheet as JSON ---
  const sheet = (name) => {
    const ws = wb.Sheets[name];
    if (!ws) return [];
    return XLSX.utils.sheet_to_json(ws, { defval: '' });
  };

  // ─── Load sheets ────────────────────────────────────────────────────────
  const ordersRaw      = sheet('Orders');
  const pgRaw          = sheet('PG_Transactions');
  const bankRaw        = sheet('Bank_Statement');
  const mdrRaw         = sheet('MDR_Rates');
  const batchRaw       = sheet('Batch_Recon');

  // ─── MDR Rate Card ──────────────────────────────────────────────────────
  const rateCard = mdrRaw.length ? mdrRaw : [];

  // ─── Normalise Orders ────────────────────────────────────────────────────
  const orders = ordersRaw.map(r => ({
    order_id:       normId(r.order_id),
    order_date:     parseDate(r.order_date),
    customer_id:    String(r.customer_id || '').trim(),
    city:           String(r.city || '').trim(),
    payment_method: String(r.payment_method || '').trim(),
    order_amount:   parseNum(r.order_amount),
    order_status:   String(r.order_status || '').trim(),
  })).filter(r => r.order_id);

  // ─── Normalise PG Transactions ──────────────────────────────────────────
  // Deduplicate: rows with identical pg_txn_id are exact duplicates → keep first
  const seenTxn = new Set();
  const pgAll = pgRaw.map(r => ({
    pg_txn_id:      String(r.pg_txn_id || '').trim(),
    original_payment_id: String(r.original_payment_id || '').trim(),
    order_ref:      normId(r.merchant_order_ref),
    txn_date:       parseDate(r.txn_date),
    txn_type:       String(r.txn_type || '').trim().toUpperCase(),
    payment_method: String(r.payment_method || '').trim(),
    gross_amount:   parseNum(r.gross_amount),
    mdr_fee:        parseNum(r.mdr_fee),
    gst_on_fee:     parseNum(r.gst_on_fee),
    net_amount:     parseNum(r.net_amount),
    settlement_date: parseDate(r.settlement_date),
    settlement_batch_id: String(r.settlement_batch_id || '').trim(),
  })).filter(r => {
    if (!r.pg_txn_id) return false;
    if (seenTxn.has(r.pg_txn_id)) return false;
    seenTxn.add(r.pg_txn_id);
    return true;
  });

  const captures = pgAll.filter(r => r.txn_type === 'CAPTURE');
  const refunds  = pgAll.filter(r => r.txn_type === 'REFUND');

  // ─── Normalise Bank Statement ────────────────────────────────────────────
  const bankEntries = bankRaw.map(r => ({
    value_date:  parseDate(r.value_date),
    narration:   String(r.narration || '').trim(),
    utr:         String(r.utr || '').trim(),
    debit:       parseNum(r.debit),
    credit:      parseNum(r.credit),
  })).filter(r => r.value_date);

  // Extract gateway settlement credits from bank (narration includes STL-…)
  const bankGwCredits = bankEntries.filter(r =>
    r.credit > 0 && /STL-\d{8}/i.test(r.narration)
  ).map(r => {
    const m = r.narration.match(/STL-\d{8}/i);
    return { ...r, batch_id: m ? m[0].toUpperCase() : '' };
  });

  // ─── Section A — KPIs ────────────────────────────────────────────────────

  const totalOrderValue = orders.reduce((s, r) => s + r.order_amount, 0);

  const paidOrders = orders.filter(r => r.order_status === 'Paid');
  const paidOrderValue = paidOrders.reduce((s, r) => s + r.order_amount, 0);

  const gatewayCaptureAmount = captures.reduce((s, r) => s + r.gross_amount, 0);

  const totalRefundsAmount = refunds.reduce((s, r) => s + r.gross_amount, 0);

  // Actual bank gateway credits
  const actualBankCredits = bankGwCredits.reduce((s, r) => s + r.credit, 0);

  // Expected net settlement = sum(net_amount of captures) - sum(gross_amount of refunds)
  const totalCaptureNet = captures.reduce((s, r) => s + r.net_amount, 0);
  const expectedNetSettlements = totalCaptureNet - totalRefundsAmount;

  // MDR/GST fee variance: expected vs actual (from PG data)
  const actualMDR = captures.reduce((s, r) => s + r.mdr_fee, 0);
  const actualGST = captures.reduce((s, r) => s + r.gst_on_fee, 0);
  const actualFees = actualMDR + actualGST;

  const expectedMDR_GST = captures.reduce((s, r) => {
    const { mdrPct, gstPct } = getMDRRate(rateCard, r.payment_method, r.gross_amount);
    const mdr = r.gross_amount * mdrPct;
    return s + mdr + mdr * gstPct;
  }, 0);

  const feeVariance = actualFees - expectedMDR_GST;

  // Potential exceptions (financial variance != 0 or missing captures)
  // We'll compute in Section B and surface here

  // ─── Section B — Payment Reconciliation ──────────────────────────────────

  // Build lookup: order_id → list of captures
  const capturesByOrder = {};
  for (const cap of captures) {
    const oid = cap.order_ref;
    if (!capturesByOrder[oid]) capturesByOrder[oid] = [];
    capturesByOrder[oid].push(cap);
  }

  const orderIdSet = new Set(orders.map(o => o.order_id));

  const reconResults = paidOrders.map(ord => {
    const caps = capturesByOrder[ord.order_id] || [];
    const totalCap = caps.reduce((s, c) => s + c.gross_amount, 0);
    const distinctCaps = caps.length;
    const amtDiff = totalCap - ord.order_amount;

    let status;
    if (caps.length === 0) status = 'no_capture';
    else if (Math.abs(amtDiff) < 0.01) status = 'matched';
    else status = 'amount_mismatch';

    return {
      order_id: ord.order_id,
      order_date: ord.order_date,
      payment_method: ord.payment_method,
      order_amount: ord.order_amount,
      capture_amount: totalCap,
      capture_count: distinctCaps,
      status,
      variance: amtDiff,
    };
  });

  // Captures with no matching paid order (orphan captures)
  const paidOrderIds = new Set(paidOrders.map(o => o.order_id));
  const orphanCaptures = captures.filter(c => !paidOrderIds.has(c.order_ref));

  const matchedCount        = reconResults.filter(r => r.status === 'matched').length;
  const noCaptureCount      = reconResults.filter(r => r.status === 'no_capture').length;
  const amtMismatchCount    = reconResults.filter(r => r.status === 'amount_mismatch').length;
  const multiCaptureOrders  = reconResults.filter(r => r.capture_count > 1);

  // ─── Section C — Fee Analysis ─────────────────────────────────────────────

  const feeByMethod = {};
  for (const cap of captures) {
    const pm = cap.payment_method || 'Unknown';
    if (!feeByMethod[pm]) feeByMethod[pm] = { method: pm, actualMDR: 0, actualGST: 0, expectedMDR: 0, expectedGST: 0, gross: 0 };
    feeByMethod[pm].actualMDR += cap.mdr_fee;
    feeByMethod[pm].actualGST += cap.gst_on_fee;
    feeByMethod[pm].gross += cap.gross_amount;
    const { mdrPct, gstPct } = getMDRRate(rateCard, pm, cap.gross_amount);
    const expMdr = cap.gross_amount * mdrPct;
    feeByMethod[pm].expectedMDR += expMdr;
    feeByMethod[pm].expectedGST += expMdr * gstPct;
  }
  const feeChartData = Object.values(feeByMethod).map(d => ({
    method: d.method,
    actualFee: +(d.actualMDR + d.actualGST).toFixed(2),
    expectedFee: +(d.expectedMDR + d.expectedGST).toFixed(2),
    variance: +((d.actualMDR + d.actualGST) - (d.expectedMDR + d.expectedGST)).toFixed(2),
  }));

  // Transactions with significant fee variance
  const feeExceptions = captures.filter(cap => {
    const { mdrPct, gstPct } = getMDRRate(rateCard, cap.payment_method, cap.gross_amount);
    const expMdr = cap.gross_amount * mdrPct;
    const expTotal = expMdr + expMdr * gstPct;
    const actTotal = cap.mdr_fee + cap.gst_on_fee;
    return Math.abs(actTotal - expTotal) > 1;
  }).map(cap => {
    const { mdrPct, gstPct } = getMDRRate(rateCard, cap.payment_method, cap.gross_amount);
    const expMdr = cap.gross_amount * mdrPct;
    const expFee = +(expMdr + expMdr * gstPct).toFixed(2);
    const actFee = +(cap.mdr_fee + cap.gst_on_fee).toFixed(2);
    return {
      pg_txn_id: cap.pg_txn_id,
      order_ref: cap.order_ref,
      payment_method: cap.payment_method,
      gross_amount: cap.gross_amount,
      expected_fee: expFee,
      actual_fee: actFee,
      variance: +(actFee - expFee).toFixed(2),
      settlement_batch: cap.settlement_batch_id,
    };
  });

  // ─── Section D — Settlement Reconciliation ───────────────────────────────

  // Group captures+refunds by batch
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

  // Bank credits keyed by batch_id
  const bankByBatch = {};
  for (const bc of bankGwCredits) {
    bankByBatch[bc.batch_id] = bc.credit;
  }

  const settlementData = Object.entries(batchCapMap).map(([bid, data]) => {
    const capNet     = data.caps.reduce((s, c) => s + c.net_amount, 0);
    const refAmt     = data.refunds.reduce((s, r) => s + r.gross_amount, 0);
    const expected   = +(capNet - refAmt).toFixed(2);
    const actual     = +(bankByBatch[bid] || 0).toFixed(2);
    const variance   = +(actual - expected).toFixed(2);
    const settlDate  = data.date;

    let status;
    const isOutsidePeriod = settlDate && settlDate > BANK_CUTOFF;
    if (isOutsidePeriod) {
      status = 'outside_period';
    } else if (!bankByBatch[bid]) {
      status = 'missing';
    } else if (Math.abs(variance) < 1) {
      status = 'matched';
    } else {
      status = 'short_paid';
    }

    return {
      batch_id: bid,
      settlement_date: dateFmt(settlDate),
      expected,
      actual,
      variance,
      status,
      tx_count: data.caps.length,
      refund_count: data.refunds.length,
    };
  }).sort((a, b) => a.batch_id.localeCompare(b.batch_id));

  // ─── Section E — Exceptions ───────────────────────────────────────────────

  const exceptions = [];

  // 1. No capture for paid order
  reconResults.filter(r => r.status === 'no_capture').forEach(r => {
    exceptions.push({
      category: 'No Gateway Capture',
      order_id: r.order_id,
      pg_txn_id: '—',
      payment_method: r.payment_method,
      txn_type: 'CAPTURE',
      gross_amount: r.order_amount,
      expected_fee: null,
      actual_fee: null,
      settlement_batch: '—',
      variance: -r.order_amount,
      action: 'Investigate missing capture record',
    });
  });

  // 2. Amount mismatches
  reconResults.filter(r => r.status === 'amount_mismatch').forEach(r => {
    exceptions.push({
      category: 'Amount Mismatch',
      order_id: r.order_id,
      pg_txn_id: '—',
      payment_method: r.payment_method,
      txn_type: 'CAPTURE',
      gross_amount: r.order_amount,
      expected_fee: null,
      actual_fee: null,
      settlement_batch: '—',
      variance: r.variance,
      action: 'Reconcile capture vs order amount',
    });
  });

  // 3. Orphan captures (no matching paid order)
  orphanCaptures.slice(0, 50).forEach(cap => {
    exceptions.push({
      category: 'Unmatched Capture',
      order_id: cap.order_ref || '—',
      pg_txn_id: cap.pg_txn_id,
      payment_method: cap.payment_method,
      txn_type: 'CAPTURE',
      gross_amount: cap.gross_amount,
      expected_fee: null,
      actual_fee: null,
      settlement_batch: cap.settlement_batch_id,
      variance: 0,
      action: 'Check order reference / clean data',
    });
  });

  // 4. Fee exceptions
  feeExceptions.slice(0, 50).forEach(fe => {
    exceptions.push({
      category: 'Fee Variance',
      order_id: fe.order_ref || '—',
      pg_txn_id: fe.pg_txn_id,
      payment_method: fe.payment_method,
      txn_type: 'CAPTURE',
      gross_amount: fe.gross_amount,
      expected_fee: fe.expected_fee,
      actual_fee: fe.actual_fee,
      settlement_batch: fe.settlement_batch,
      variance: fe.variance,
      action: fe.variance > 0 ? 'Overcharged — request credit note' : 'Undercharged — verify rate',
    });
  });

  // 5. Settlement issues
  settlementData.filter(r => r.status === 'missing' || r.status === 'short_paid').forEach(r => {
    exceptions.push({
      category: r.status === 'missing' ? 'Missing Settlement' : 'Short Settlement',
      order_id: '—',
      pg_txn_id: '—',
      payment_method: '—',
      txn_type: 'SETTLEMENT',
      gross_amount: r.expected,
      expected_fee: null,
      actual_fee: null,
      settlement_batch: r.batch_id,
      variance: r.variance,
      action: r.status === 'missing'
        ? 'Raise query with gateway'
        : 'Reconcile short payment with gateway',
    });
  });

  // Potential financial exception total (unique financial impact)
  const potentialExceptions = feeExceptions.reduce((s, e) => s + Math.abs(e.variance), 0)
    + settlementData.filter(r => r.status === 'short_paid').reduce((s, r) => s + Math.abs(r.variance), 0);

  // ─── Settlement chart data ────────────────────────────────────────────────
  const settlementChartData = settlementData.slice(0, 30).map(d => ({
    batch: d.batch_id.replace('STL-', ''),
    expected: d.expected,
    actual: d.actual,
    status: d.status,
  }));

  // ─── Recon chart data ─────────────────────────────────────────────────────
  const reconChartData = [
    { name: 'Matched', count: matchedCount, value: reconResults.filter(r => r.status === 'matched').reduce((s,r)=>s+r.order_amount,0), fill: '#00c9a7' },
    { name: 'No Capture', count: noCaptureCount, value: reconResults.filter(r => r.status === 'no_capture').reduce((s,r)=>s+r.order_amount,0), fill: '#ff5f7e' },
    { name: 'Orphan Captures', count: orphanCaptures.length, value: orphanCaptures.reduce((s,c)=>s+c.gross_amount,0), fill: '#ffb347' },
    { name: 'Amt Mismatch', count: amtMismatchCount, value: reconResults.filter(r => r.status === 'amount_mismatch').reduce((s,r)=>s+Math.abs(r.variance),0), fill: '#5ba4ff' },
    { name: 'Multi-Capture', count: multiCaptureOrders.length, value: multiCaptureOrders.reduce((s,r)=>s+r.order_amount,0), fill: '#c8a0ff' },
  ];

  // ─── Return everything ────────────────────────────────────────────────────
  return {
    // metadata
    orders, captures, refunds, bankEntries, bankGwCredits, rateCard,

    // KPIs
    kpis: {
      totalOrderValue,
      paidOrderValue,
      gatewayCaptureAmount,
      totalRefundsAmount,
      actualBankCredits,
      expectedNetSettlements,
      feeVariance,
      potentialExceptions,
      orderCount: orders.length,
      paidOrderCount: paidOrders.length,
      captureCount: captures.length,
      refundCount: refunds.length,
    },

    // Section B
    reconResults,
    reconChartData,
    orphanCaptures,
    matchedCount,
    noCaptureCount,
    amtMismatchCount,
    multiCaptureOrders,

    // Section C
    feeChartData,
    feeExceptions,
    actualMDR,
    actualGST,
    expectedMDR_GST,

    // Section D
    settlementData,
    settlementChartData,

    // Section E
    exceptions,
  };
}
