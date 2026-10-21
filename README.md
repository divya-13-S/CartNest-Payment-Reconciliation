# CartNest Payment Gateway Reconciliation Dashboard

A browser-only, React + Vite dashboard for the **CartNest September 2026 PG Reconciliation** assessment.

## Tech Stack
- **React 19** + **Vite 6** — front-end framework and build tool
- **Recharts** — interactive charts
- **SheetJS (xlsx)** — workbook parsing directly in the browser

---

## Quick Start

### 1. Install dependencies (already done if you ran `npm install`)
```powershell
npm install
```

### 2. Start the development server
```powershell
npm run dev
```
Open **http://localhost:5173** in your browser.

### 3. Load the workbook
Click **Browse File** and select **`PGRecon_Working.xlsx`** from this folder.

All data processing happens in the browser — no backend or server required.

---

## Dashboard Sections

| Tab | What it shows |
|-----|---------------|
| **Overview** | 8 KPI cards: total orders, paid orders, gateway captures, refunds, bank credits, expected net settlements, fee variance, potential exceptions |
| **Payment Recon** | Matched / no-capture / amount-mismatch / multi-capture charts + detail table |
| **Fee Analysis** | Expected vs actual MDR + GST by payment method + fee exception table |
| **Settlements** | Expected vs actual bank credit per batch, status highlighted (matched / short-paid / missing / outside period) |
| **Exceptions** | Searchable table of all exceptions with category, order ID, txn ID, variance, recommended action |

## Filters
Use the filter bar to narrow results by:
- Date range
- Payment method
- Transaction type (Capture / Refund)
- Exception category
- Settlement status

Click **↺ Reset** to clear all filters.

---

## Data Rules Applied
- Exact duplicate PG transaction IDs are deduplicated (first occurrence kept)
- Refunds are not deducted twice
- October settlement batches are marked **Outside Bank Period**, not missing
- MDR rates applied per the rate card (UPI ≤₹2000 = 0%, Card = 1.6–1.8%, etc.)
- All INR amounts shown in Indian number format (e.g. ₹1,23,456.78)

---

## Project Structure
```
CartNest_Dashboard/
├── index.html
├── src/
│   ├── main.jsx          — React entry point
│   ├── App.jsx           — Main dashboard (all 5 sections)
│   ├── styles.css        — Dark navy/teal theme
│   ├── dataProcessor.js  — Workbook parsing & all calculations
│   └── components/
│       ├── KPICard.jsx
│       └── FiltersBar.jsx
├── PGRecon_Working.xlsx  — Source workbook (do not delete)
├── orders.csv
├── pg_transactions.csv
├── bank_statement.csv
└── mdr_rate_card.csv
```
