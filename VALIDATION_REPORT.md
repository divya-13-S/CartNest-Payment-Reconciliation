# CartNest Payment Gateway Reconciliation — Validation Report

**Updated:** 2026-10-21  
**Dashboard version:** Post-fix v2 (all calculation bugs resolved)  
**Primary source:** `PGRecon_Working.xlsx`  
**Cross-check:** `orders.csv`, `pg_transactions.csv`, `bank_statement.csv`, `mdr_rate_card.csv`

---

## Root Cause Summary — Two Separate Bugs

### Bug 1 — ID Normalization (fixed in v1)

`PG_Transactions.merchant_order_ref` contains two formats:

| Format | Example |
|--------|---------|
| No hyphen (matches Orders) | `ORD26000066` |
| **With hyphen (mismatch!)** | `ORD-26000130` |

The old `prepare-data.mjs` used `merchant_order_ref` as the lookup key after only trimming/uppercasing — hyphens were left in. The workbook's `Normalized_Order_Ref` column already strips hyphens, but the script's `||` fallback never triggered because `merchant_order_ref` is never empty.

**Fix:** `normId()` now strips hyphens (`replace(/[-\s]/g, '')`), and `Normalized_Order_Ref` is used as the **primary** matching key.

**Impact:** Orphan captures dropped from 177 → 8. Matched orders rose from ~2,972 → 5,214.

---

### Bug 2 — `reconResults` slice (fixed in v2)

`prepare-data.mjs` stored only `reconResults.slice(0, 3000)` in the JSON. There are **5,255 paid orders**, so 2,255 were silently dropped. App.jsx computed KPI counts from this truncated array via `filteredRecon.filter(…)`, giving wrong totals even though the correct full counts (`matchedCount`, `noCaptureCount`, etc.) were stored as separate top-level fields in the JSON.

**Fix 1 — Data layer:** Removed the `slice(0, 3000)` limit. The JSON now contains all 5,255 `reconResults` rows (~1 MB total — acceptable for a local dashboard).

**Fix 2 — UI layer:** KPI cards now use the stored full-dataset counts when no filter is active, and switch to `filteredRecon.filter(…)` only when a date or payment-method filter is applied. This ensures the table display slice (200 rows) never affects the headline counts.

---

## Payment Reconciliation Validation Table

| KPI | Label | Before fix | After fix | Reference | Pass? |
|-----|-------|-----------|-----------|-----------|-------|
| Matched Orders (Paid) | Paid orders where total capture = order amount | 2,971 | **5,214** | 5,214 | ✅ |
| Paid Orders — No Capture | Paid with zero matching captures | 13 | **20** | 20 | ✅ |
| Amount Mismatch | Single capture ≠ order amount (non-multi-cap) | 13 | **15** | 15 | ✅ |
| Multi-Capture Orders | Paid orders with >1 distinct capture ID | 6 | **6** | 6 | ✅ (was correct) |
| Orphan Captures | Captures whose ref matches no order (any status) | 8 | **8** | 8 | ✅ (was correct) |

### Why the three counts were off by exactly the same amount

`reconResults` was sliced to 3,000 out of 5,255 paid orders. The 3,000 included:

| Status | In slice | Full dataset | Missing |
|--------|---------|-------------|---------|
| matched | 2,971 | 5,214 | 2,243 |
| no_capture | 13 | 20 | 7 |
| amount_mismatch | 13 | 15 | 2 |
| multi_capture | 3 | 6 | 3 |

The slice happened to be the first 3,000 rows in the order the workbook lists them. The missing rows were all real paid orders whose statuses were simply not represented in the truncated list.

---

## Metric Definitions (non-overlapping)

| KPI | Population | Status in workbook |
|-----|-----------|-------------------|
| **Matched Orders (Paid)** | Paid orders, exactly one or more captures summing exactly to the order amount | `Amount Match` |
| **Paid Orders — No Capture** | Paid orders with zero matching capture transactions | `No Capture` |
| **Amount Mismatch** | Paid orders with captures summing to ≠ order amount, excluding multi-capture orders | Computed (single cap, non-zero variance) |
| **Multi-Capture Orders** | Paid orders with >1 distinct `pg_txn_id` mapped to the same order ref | `Multiple Capture Rows - Review` |
| **Orphan Captures** | CAPTURE transactions whose `Normalized_Order_Ref` matches no order in the dataset (any status) | N/A — transactions not orders |

> **Note on overlap:** Multi-capture orders are categorised as `multi_capture`, not `amount_mismatch`, even when their total capture differs from the order amount. This matches the workbook's categorisation and keeps the five KPIs mutually exclusive.

---

## No-Capture Paid Orders (20 confirmed)

Total unrecovered amount: **₹67,617.00**

The workbook confirms all 20 have `Reconciliation_Status = "No Capture"` and `Capture_Count = 0`. No normalization issue — these orders genuinely have no capture in the gateway feed.

---

## Multi-Capture Orders (6 confirmed)

All 6 orders have exactly 2 distinct `pg_txn_id` values. No duplicate transaction IDs are counted separately — deduplication by `pg_txn_id` occurs before the grouping step.

| Order ID | Order Amt | Captured Amt | Captures |
|----------|-----------|-------------|---------|
| ORD26000315 | ₹1,947 | ₹3,894 | 2 |
| ORD26001480 | ₹12,998 | ₹25,996 | 2 |
| ORD26002388 | ₹4,797 | ₹9,594 | 2 |
| ORD26003440 | ₹3,499 | ₹6,998 | 2 |
| ORD26003962 | ₹1,499 | ₹2,998 | 2 |
| ORD26005730 | ₹799 | ₹1,598 | 2 |

---

## Orphan Captures (8 confirmed)

Total gross: **₹24,992.00**

These 8 capture transactions reference an order ID that does not exist anywhere in the Orders sheet (any status). They are **not** captures against Failed/Cancelled orders — those are correctly excluded from the orphan count.

---

## Dataset Counts Validation

| Metric | Reference | Dashboard | Pass? |
|--------|-----------|-----------|-------|
| Total orders | 6,000 | **6,000** | ✅ |
| Paid orders | 5,255 | **5,255** | ✅ |
| PG transaction rows (raw) | 5,752 | **5,752** | ✅ |
| Raw capture rows | 5,509 | **5,509** | ✅ |
| Refund rows | 243 | **243** | ✅ |
| Duplicate `pg_txn_id` values | 10 | **10** | ✅ |
| Rows in duplicates | 20 | **20** | ✅ |
| Unique IDs after dedup | 5,742 | **5,742** | ✅ |
| All-order matched (all statuses) | 5,464 | N/A* | — |
| Paid no-capture amount | ₹67,617 | **₹67,617** | ✅ |
| Orphan gross total | ₹24,992 | **₹24,992** | ✅ |

> *The "all-order matched" figure (5,464) covers all 6,000 orders regardless of status. The dashboard's Matched Orders KPI covers **Paid orders only** (5,214). The 250-order difference is non-Paid orders (Failed, Cancelled, Refunded) that happen to have a matching capture — these are not operationally relevant for a paid-order dashboard.

---

## Financial KPIs Validation

| KPI | Value | Formula | Pass? |
|-----|-------|---------|-------|
| Total Order Value | ₹2,17,28,505.00 | Sum of all `order_amount` | ✅ |
| Paid Order Value | ₹1,89,84,402.00 | Sum of Paid order amounts | ✅ |
| Gateway Capture Amount | ₹1,99,02,749.00 | Sum of deduped CAPTURE `gross_amount` | ✅ |
| Total Refunds | ₹8,93,888.00 | Sum of deduped REFUND `gross_amount` | ✅ |
| Actual Bank Credits | ₹1,69,84,048.56 | STL-* credit entries from Bank_Statement | ✅ |
| Expected Net Settlements | ₹1,88,01,899.49 | Sum of capture `net_amount` − refund gross | ✅ |
| MDR + GST Fee Variance | ₹1,185.20 | Actual fees − Expected fees per rate card | ✅ |
| Fee + Shortfall Variance | ₹2,435.20 | ₹1,185.20 fee variance + ₹1,250.00 short settlement | ✅ |

> **Fee + Shortfall Variance (formerly "Potential Exceptions"):** This is a **partial** total. It captures only the quantified fee overcharge and the one short-paid settlement batch. It does not include the value of the 20 no-capture orders (₹67,617), the 15 amount-mismatch shortfalls, or the 6 multi-capture orders, as these require investigation before a monetary impact can be confirmed.

---

## Overview KPI Label Changes

| Before | After | Reason |
|--------|-------|--------|
| Subtitle: "Net captures minus refunds" | "Capture gross − refunds − actual MDR/GST" | Clarifies that `net_amount` (which already nets MDR/GST) is used, not gross captures |
| Label: "Potential Exceptions" | "Fee + Shortfall Variance" | The ₹2,435.20 is specifically fee variance + settlement shortfall — calling it "potential exceptions" overstated a much larger unquantified risk |
| Subtitle: "N exception records" | "Fee variance + short-settlement only — excludes other open exceptions" | Explains what the figure does and does not include |

---

## Exception Table — All Categories

| Category | Count | Definition |
|----------|-------|-----------|
| No Gateway Capture | 20 | Paid orders with no capture |
| Amount Mismatch | 15 | Paid, single capture, amount differs |
| Multi-Capture — Review | 6 | Paid, >1 distinct capture |
| Unmatched Capture | 8 | Capture with no matching order |
| Fee Variance | 50 | Capture MDR+GST vs expected > ₹1 |
| Short Settlement | 1 | Batch: actual credit < expected |
| Missing Settlement | 1 | Batch: no bank credit found |
| **Total** | **101** | |

Exception rows include: Order ID, Gateway Txn ID, Order Status, Payment Method, Transaction Type, Order Amount, Captured Amount, Expected Fee, Actual Fee, Settlement Batch, Variance, Action.

---

## Files Changed

| File | Change |
|------|--------|
| `scripts/prepare-data.mjs` | Removed `slice(0, 3000)` from `reconResults` |
| `src/App.jsx` | KPI cards use stored full counts when unfiltered; use `filteredRecon` counts when filter active. Updated Overview subtitles. Renamed "Potential Exceptions". |
| `public/data/dashboard-data.json` | Regenerated — 1,032 KB (all 5,255 paid orders) |
| `VALIDATION_REPORT.md` | This file |

**Unchanged:** `PGRecon_Working.xlsx`, all CSV files, `src/styles.css`, all filter logic, settlement section, fee analysis section, chart visual design.

---

## Verification Checklist

- [x] `npm run prepare-data` — 5,255 reconResults rows, correct top-level counts
- [x] `vite build` — ✓ built in 741ms, zero errors
- [x] Dev server running at http://localhost:5173 (or 5174 if port busy)
- [x] Payment Recon tab — Matched: **5,214** · No Capture: **20** · Mismatch: **15** · Multi-Capture: **6** · Orphans: **8**
- [x] Overview — Expected Net Settlements subtitle updated
- [x] Overview — "Fee + Shortfall Variance" label and subtitle updated
- [x] All 5 filters work; Reset Filters restores full-dataset totals
- [x] No-Capture subtitle shows ₹67,617; Orphan subtitle shows ₹24,992
- [x] Theme, layout, colours, settlement section, fee section — unchanged
