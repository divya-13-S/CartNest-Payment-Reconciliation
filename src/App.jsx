import { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell
} from 'recharts';
import './styles.css';

// ── Indian currency formatter ──────────────────────────────────────────────
function fmtINR(num) {
  if (num == null || isNaN(num)) return '₹—';
  const n    = Math.abs(Number(num));
  const sign = Number(num) < 0 ? '-' : '';
  const parts = n.toFixed(2).split('.');
  let int = parts[0];
  if (int.length > 3) {
    const last3 = int.slice(-3);
    const rest  = int.slice(0, -3);
    int = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }
  return `${sign}₹${int}.${parts[1]}`;
}

const DEFAULT_FILTERS = {
  dateFrom: '', dateTo: '', paymentMethod: '',
  txnType: '', exceptionCategory: '', settlementStatus: '',
};

const TABS = ['Overview', 'Payment Recon', 'Fee Analysis', 'Settlements', 'Exceptions'];

// ── Custom Recharts tooltip ────────────────────────────────────────────────
const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: '#fff', border: '1px solid #E6E0D5', borderRadius: 8,
      padding: '10px 14px', fontSize: 12, color: '#30352F',
      boxShadow: '0 2px 10px rgba(48,53,47,.09)',
    }}>
      <p style={{ fontWeight: 600, marginBottom: 5, color: '#30352F' }}>{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color || p.fill, margin: '3px 0' }}>
          {p.name}: {Math.abs(p.value) > 100 ? fmtINR(p.value) : p.value.toLocaleString('en-IN')}
        </p>
      ))}
    </div>
  );
};

// ── Status badge ───────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const map = {
    matched:        ['badge-green',   'Matched'],
    short_paid:     ['badge-amber',   'Short-paid'],
    missing:        ['badge-red',     'Missing'],
    outside_period: ['badge-blue',    'Outside Period'],
    no_capture:     ['badge-red',     'No Capture'],
    amount_mismatch:['badge-amber',   'Amt Mismatch'],
    multi_capture:  ['badge-purple',  'Multi-Capture'],
  };
  const [cls, label] = map[status] || ['badge-neutral', status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

// ── Category badge ─────────────────────────────────────────────────────────
function CatBadge({ cat }) {
  const m = {
    'No Gateway Capture':   'badge-red',
    'Amount Mismatch':      'badge-amber',
    'Multi-Capture — Review': 'badge-purple',
    'Unmatched Capture':    'badge-blue',
    'Fee Variance':         'badge-amber',
    'Missing Settlement':   'badge-red',
    'Short Settlement':     'badge-amber',
  };
  return <span className={`badge ${m[cat] || 'badge-neutral'}`}>{cat}</span>;
}

// ── KPI Card ───────────────────────────────────────────────────────────────
function KPICard({ icon, label, value, sub, variant = '', valueClass = '' }) {
  return (
    <div className={`kpi-card ${variant ? `variant-${variant}` : ''}`}>
      {icon && <div className="kpi-icon">{icon}</div>}
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${valueClass}`}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

// ── Section header ─────────────────────────────────────────────────────────
function SectionTitle({ children }) {
  return (
    <div className="section-title">
      <span className="section-title-bar" />
      {children}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
export default function App() {
  const [data,      setData]      = useState(null);
  const [loadErr,   setLoadErr]   = useState('');
  const [loading,   setLoading]   = useState(true);
  const [activeTab, setActiveTab] = useState(0);
  const [filters,   setFilters]   = useState(DEFAULT_FILTERS);
  const [search,    setSearch]    = useState('');

  // ── Auto-load JSON on mount ────────────────────────────────────────────
  useEffect(() => {
    fetch('/data/dashboard-data.json')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`);
        return r.json();
      })
      .then(json => { setData(json); setLoading(false); })
      .catch(err => { setLoadErr(err.message); setLoading(false); });
  }, []);

  // ── Filter helpers ─────────────────────────────────────────────────────
  const inDateRange = (dateStr) => {
    if (!dateStr) return true;
    if (filters.dateFrom && dateStr < filters.dateFrom) return false;
    if (filters.dateTo   && dateStr > filters.dateTo)   return false;
    return true;
  };

  const filteredRecon = useMemo(() => {
    if (!data) return [];
    return data.reconResults.filter(r => {
      if (filters.paymentMethod && r.payment_method !== filters.paymentMethod) return false;
      if (!inDateRange(r.order_date)) return false;
      return true;
    });
  }, [data, filters]);

  const filteredSettlements = useMemo(() => {
    if (!data) return [];
    return data.settlementData.filter(s => {
      if (filters.settlementStatus && s.status !== filters.settlementStatus) return false;
      if (!inDateRange(s.settlement_date)) return false;
      return true;
    });
  }, [data, filters]);

  const filteredExceptions = useMemo(() => {
    if (!data) return [];
    return data.exceptions.filter(ex => {
      if (filters.exceptionCategory && ex.category !== filters.exceptionCategory) return false;
      if (filters.paymentMethod && ex.payment_method !== '—' && ex.payment_method !== filters.paymentMethod) return false;
      if (filters.txnType && ex.txn_type !== filters.txnType) return false;
      const q = search.toLowerCase();
      if (q) {
        const row = `${ex.order_id} ${ex.pg_txn_id} ${ex.category} ${ex.payment_method} ${ex.settlement_batch}`.toLowerCase();
        if (!row.includes(q)) return false;
      }
      return true;
    });
  }, [data, filters, search]);

  // Derived recon counts:
  // When no recon-relevant filter (date or payment method) is active, use the
  // pre-computed full-dataset totals stored in the JSON (avoids any truncation
  // artefact). When a filter IS active, compute from the filtered array.
  const reconFiltered = filters.dateFrom || filters.dateTo || filters.paymentMethod;
  const reconMatchedCount     = reconFiltered ? filteredRecon.filter(r=>r.status==='matched').length       : (data?.matchedCount     ?? 0);
  const reconNoCaptureCount   = reconFiltered ? filteredRecon.filter(r=>r.status==='no_capture').length     : (data?.noCaptureCount   ?? 0);
  const reconMismatchCount    = reconFiltered ? filteredRecon.filter(r=>r.status==='amount_mismatch').length : (data?.amtMismatchCount ?? 0);
  const reconMultiCapCount    = reconFiltered ? filteredRecon.filter(r=>r.status==='multi_capture').length   : (data?.multiCaptureCount?? 0);

  const filteredReconChart = useMemo(() => {
    if (!data) return [];
    if (!filters.paymentMethod && !filters.dateFrom && !filters.dateTo) return data.reconChartData;
    const rr = filteredRecon;
    return [
      { name: 'Matched',       count: rr.filter(r=>r.status==='matched').length,         value: rr.filter(r=>r.status==='matched').reduce((s,r)=>s+r.order_amount,0),              color: '#71866A' },
      { name: 'No Capture',    count: rr.filter(r=>r.status==='no_capture').length,       value: rr.filter(r=>r.status==='no_capture').reduce((s,r)=>s+r.order_amount,0),            color: '#C9856B' },
      { name: 'Amt Mismatch',  count: rr.filter(r=>r.status==='amount_mismatch').length,  value: rr.filter(r=>r.status==='amount_mismatch').reduce((s,r)=>s+Math.abs(r.variance),0), color: '#6F9990' },
      { name: 'Multi-Cap',     count: rr.filter(r=>r.status==='multi_capture').length,    value: rr.filter(r=>r.status==='multi_capture').reduce((s,r)=>s+r.order_amount,0),          color: '#9B8EC4' },
    ];
  }, [data, filteredRecon, filters]);

  // ── Render states ──────────────────────────────────────────────────────
  const header = (
    <header className="header">
      <div className="header-brand">
        <div className="header-logo">🏦</div>
        <div>
          <div className="header-title">CartNest PG Reconciliation Dashboard</div>
          <div className="header-subtitle">Payment Gateway · September 2026</div>
        </div>
      </div>
      <div className="header-right">
        <div className="header-period">
          <strong>Sep 2026</strong>
          Bank statement: 01–30 Sep 2026
        </div>
        {data && (
          <div className="header-stats">
            <div className="header-stat">
              <strong>{data.kpis.orderCount.toLocaleString('en-IN')}</strong>
              Orders
            </div>
            <div className="header-stat">
              <strong>{data.kpis.captureCount.toLocaleString('en-IN')}</strong>
              Captures
            </div>
            <div className="header-stat">
              <strong>{data.kpis.refundCount}</strong>
              Refunds
            </div>
          </div>
        )}
      </div>
    </header>
  );

  if (loading) return (
    <div className="app">
      {header}
      <div className="main">
        <div className="loading-state">
          <div className="spinner" />
          <p>Loading reconciliation data…</p>
        </div>
      </div>
    </div>
  );

  return (
    <div className="app">
      {header}
      <div className="main">

        {/* Error banner — inline, doesn't replace the page */}
        {loadErr && (
          <div className="error-banner">
            ⚠️ &nbsp;Could not load dashboard data: <strong>{loadErr}</strong>
            &nbsp;— Run <code>npm run prepare-data</code> then refresh.
          </div>
        )}

        {/* ── Filters ─────────────────────────────────────────────────── */}
        <div className="filters-bar">
          <div className="filter-group">
            <label htmlFor="f-date-from">From Date</label>
            <input id="f-date-from" type="date" value={filters.dateFrom}
              onChange={e => setFilters(f => ({ ...f, dateFrom: e.target.value }))} />
          </div>
          <div className="filter-group">
            <label htmlFor="f-date-to">To Date</label>
            <input id="f-date-to" type="date" value={filters.dateTo}
              onChange={e => setFilters(f => ({ ...f, dateTo: e.target.value }))} />
          </div>
          <div className="filter-group">
            <label htmlFor="f-pmt">Payment Method</label>
            <select id="f-pmt" value={filters.paymentMethod}
              onChange={e => setFilters(f => ({ ...f, paymentMethod: e.target.value }))}>
              <option value="">All Methods</option>
              {(data?.paymentMethods || []).map(pm => (
                <option key={pm} value={pm}>{pm}</option>
              ))}
            </select>
          </div>
          <div className="filter-group">
            <label htmlFor="f-txn">Transaction Type</label>
            <select id="f-txn" value={filters.txnType}
              onChange={e => setFilters(f => ({ ...f, txnType: e.target.value }))}>
              <option value="">All Types</option>
              <option value="CAPTURE">Capture</option>
              <option value="REFUND">Refund</option>
              <option value="SETTLEMENT">Settlement</option>
            </select>
          </div>
          <div className="filter-group">
            <label htmlFor="f-exc">Exception Category</label>
            <select id="f-exc" value={filters.exceptionCategory}
              onChange={e => setFilters(f => ({ ...f, exceptionCategory: e.target.value }))}>
              <option value="">All Categories</option>
              <option value="No Gateway Capture">No Gateway Capture</option>
              <option value="Amount Mismatch">Amount Mismatch</option>
              <option value="Unmatched Capture">Unmatched Capture</option>
              <option value="Fee Variance">Fee Variance</option>
              <option value="Missing Settlement">Missing Settlement</option>
              <option value="Short Settlement">Short Settlement</option>
            </select>
          </div>
          <div className="filter-group">
            <label htmlFor="f-stl">Settlement Status</label>
            <select id="f-stl" value={filters.settlementStatus}
              onChange={e => setFilters(f => ({ ...f, settlementStatus: e.target.value }))}>
              <option value="">All</option>
              <option value="matched">Matched</option>
              <option value="short_paid">Short-paid</option>
              <option value="missing">Missing</option>
              <option value="outside_period">Outside Period</option>
            </select>
          </div>
          <button className="reset-btn" id="btn-reset-filters"
            onClick={() => { setFilters(DEFAULT_FILTERS); setSearch(''); }}>
            ↺ Reset Filters
          </button>
        </div>
        {/* Active filter indicator */}
        {Object.values(filters).some(v => v !== '') && (
          <div className="filters-active-row">
            <span className="filters-active-pill">
              {Object.values(filters).filter(v => v !== '').length} filter
              {Object.values(filters).filter(v => v !== '').length > 1 ? 's' : ''} active
            </span>
            <span className="filters-active-hint">Charts and tables below reflect the selected filters.</span>
          </div>
        )}


        {/* ── Tab navigation ──────────────────────────────────────────── */}
        <div className="tabs-wrap">
          {TABS.map((t, i) => (
            <button key={t} className={`tab-btn ${activeTab === i ? 'active' : ''}`}
              onClick={() => setActiveTab(i)}>{t}</button>
          ))}
        </div>

        {/* ══════════════════════════════════════════════════════════════
            SECTION A — Overview
        ══════════════════════════════════════════════════════════════ */}
        {activeTab === 0 && data && (
          <div className="section">
            <SectionTitle>Overview KPIs — September 2026</SectionTitle>
            <div className="kpi-grid">
              <KPICard icon="🛒" label="Total Order Value"
                value={fmtINR(data.kpis.totalOrderValue)}
                sub={`${data.kpis.orderCount.toLocaleString('en-IN')} orders`} />
              <KPICard icon="✅" label="Paid Order Value"
                value={fmtINR(data.kpis.paidOrderValue)}
                sub={`${data.kpis.paidOrderCount.toLocaleString('en-IN')} paid orders`}
                variant="success" valueClass="v-success" />
              <KPICard icon="💳" label="Gateway Capture Amount"
                value={fmtINR(data.kpis.gatewayCaptureAmount)}
                sub={`${data.kpis.captureCount.toLocaleString('en-IN')} unique captures`}
                variant="teal" />
              <KPICard icon="↩️" label="Total Refunds"
                value={fmtINR(data.kpis.totalRefundsAmount)}
                sub={`${data.kpis.refundCount} refund transactions`}
                variant="warning" valueClass="v-warning" />
              <KPICard icon="🏦" label="Actual Bank Credits"
                value={fmtINR(data.kpis.actualBankCredits)}
                sub="Gateway settlements received"
                variant="info" />
              <KPICard icon="📊" label="Expected Net Settlements"
                value={fmtINR(data.kpis.expectedNetSettlements)}
                sub="Capture gross − refunds − actual MDR/GST" />
              <KPICard icon="⚖️" label="MDR + GST Fee Variance"
                value={fmtINR(data.kpis.feeVariance)}
                sub={`Actual ${fmtINR(data.actualMDR + data.actualGST)} vs Expected ${fmtINR(data.expectedMDR_GST)}`}
                variant={Math.abs(data.kpis.feeVariance) > 5000 ? 'warning' : ''}
                valueClass={Math.abs(data.kpis.feeVariance) > 5000 ? 'v-warning' : ''} />
              <KPICard icon="⚠️" label="Fee + Shortfall Variance"
                value={fmtINR(data.kpis.potentialExceptions)}
                sub="Fee variance + short-settlement only — excludes other open exceptions"
                variant="danger" valueClass="v-danger" />
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════
            SECTION B — Payment Reconciliation
        ══════════════════════════════════════════════════════════════ */}
        {activeTab === 1 && data && (
          <div className="section">
            <SectionTitle>Payment Reconciliation</SectionTitle>

            {/* Summary cards — KPI counts from full stored totals when unfiltered */}
            <div className="kpi-grid section-gap">
              <KPICard icon="✅" label="Matched Orders (Paid)"
                value={reconMatchedCount}
                sub="Exact capture = order amount (Paid orders only)" variant="success" valueClass="v-success" />
              <KPICard icon="❌" label="Paid Orders — No Capture"
                value={reconNoCaptureCount}
                sub={`Paid with no gateway capture — ₹${(data.noCaptureAmount||0).toLocaleString('en-IN',{minimumFractionDigits:2})}`} variant="danger" valueClass="v-danger" />
              <KPICard icon="⚠️" label="Amount Mismatch"
                value={reconMismatchCount}
                sub="Single capture ≠ order amount" variant="warning" valueClass="v-warning" />
              <KPICard icon="🔁" label="Multi-Capture Orders"
                value={reconMultiCapCount}
                sub="Orders with >1 distinct capture ID" variant="info" />
              <KPICard icon="👻" label="Orphan Captures"
                value={data.orphanCount}
                sub={`No matching order — ₹${(data.orphanGrossTotal||0).toLocaleString('en-IN',{minimumFractionDigits:2})}`} variant="warning" valueClass="v-warning" />
            </div>

            {/* Charts */}
            <div className="chart-grid">
              <div className="chart-card">
                <div className="chart-title">Reconciliation Status — Order Count</div>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={filteredReconChart} margin={{ top: 5, right: 16, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E6E0D5" />
                    <XAxis dataKey="name" tick={{ fill: '#74776F', fontSize: 11 }} />
                    <YAxis tick={{ fill: '#74776F', fontSize: 11 }} />
                    <Tooltip content={<ChartTooltip />} />
                    <Bar dataKey="count" name="Order Count" radius={[4, 4, 0, 0]}>
                      {filteredReconChart.map((e, i) => <Cell key={i} fill={e.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="chart-card">
                <div className="chart-title">Order Value by Status</div>
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie data={filteredReconChart.filter(d => d.value > 0)} dataKey="value" nameKey="name"
                      cx="50%" cy="48%" outerRadius={100} innerRadius={50}
                      paddingAngle={2}
                      label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                      labelLine={false}>
                      {filteredReconChart.filter(d => d.value > 0).map((e, i) => <Cell key={i} fill={e.color} />)}
                    </Pie>
                    <Tooltip content={<ChartTooltip />} />
                    <Legend iconType="circle" iconSize={10} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Detail table */}
            <div className="table-wrapper">
              <div className="table-toolbar">
                <h3>Reconciliation Detail</h3>
                <span className="table-count">{filteredRecon.length} paid orders</span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Order ID</th><th>Date</th><th>Status</th><th>Method</th>
                      <th>Order Amt</th><th>Capture Amt</th><th>Captures</th>
                      <th>Variance</th><th>Recon Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRecon.slice(0, 200).map((r, i) => (
                      <tr key={i}>
                        <td className="mono">{r.order_id}</td>
                        <td>{r.order_date}</td>
                        <td><span className="badge badge-neutral" style={{fontSize:10}}>{r.order_status}</span></td>
                        <td>{r.payment_method}</td>
                        <td>{fmtINR(r.order_amount)}</td>
                        <td>{r.capture_amount > 0 ? fmtINR(r.capture_amount) : '—'}</td>
                        <td style={{ textAlign: 'center' }}>{r.capture_count}</td>
                        <td className={r.variance === 0 ? '' : r.variance > 0 ? 'amt-pos' : 'amt-neg'}>
                          {r.variance !== 0 ? fmtINR(r.variance) : '—'}
                        </td>
                        <td><StatusBadge status={r.status} /></td>
                      </tr>
                    ))}
                    {filteredRecon.length === 0 && (
                      <tr><td colSpan={9} className="no-data">No records match the current filters.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════
            SECTION C — Fee Analysis
        ══════════════════════════════════════════════════════════════ */}
        {activeTab === 2 && data && (
          <div className="section">
            <SectionTitle>Gateway Fee Analysis</SectionTitle>

            <div className="kpi-grid section-gap">
              <KPICard icon="💸" label="Actual MDR"          value={fmtINR(data.actualMDR)} />
              <KPICard icon="🏛️" label="Actual GST on MDR"  value={fmtINR(data.actualGST)} />
              <KPICard icon="💰" label="Total Actual Fees"   value={fmtINR(data.actualMDR + data.actualGST)} />
              <KPICard icon="📋" label="Expected Fees"        value={fmtINR(data.expectedMDR_GST)} sub="Per rate card" />
              <KPICard icon="⚖️" label="Fee Variance"
                value={fmtINR(data.kpis.feeVariance)}
                sub={data.kpis.feeVariance > 0 ? 'Overcharged' : data.kpis.feeVariance < 0 ? 'Undercharged' : 'No variance'}
                variant={Math.abs(data.kpis.feeVariance) > 5000 ? 'warning' : 'success'}
                valueClass={Math.abs(data.kpis.feeVariance) > 5000 ? 'v-warning' : 'v-success'} />
              <KPICard icon="🔍" label="Fee Exception Txns"
                value={data.feeExceptions.length}
                sub="MDR/GST variance > ₹1"
                variant={data.feeExceptions.length > 0 ? 'warning' : 'success'}
                valueClass={data.feeExceptions.length > 0 ? 'v-warning' : 'v-success'} />
            </div>

            <div className="chart-grid cols-1 section-gap">
              <div className="chart-card">
                <div className="chart-title">Expected vs Actual Fees by Payment Method</div>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={data.feeChartData} margin={{ top: 5, right: 24, left: 20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E6E0D5" />
                    <XAxis dataKey="method" tick={{ fill: '#74776F', fontSize: 11 }} />
                    <YAxis tick={{ fill: '#74776F', fontSize: 11 }}
                      tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
                    <Tooltip content={<ChartTooltip />} />
                    <Legend iconType="square" iconSize={10} />
                    <Bar dataKey="expectedFee" name="Expected Fee" fill="#6F9990" radius={[3,3,0,0]} />
                    <Bar dataKey="actualFee"   name="Actual Fee"   fill="#71866A" radius={[3,3,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="table-wrapper">
              <div className="table-toolbar">
                <h3>Fee Exception Transactions</h3>
                <span className="table-count">{data.feeExceptions.length} transactions</span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Gateway Txn ID</th><th>Order Ref</th><th>Method</th>
                      <th>Gross Amount</th><th>Expected Fee</th><th>Actual Fee</th>
                      <th>Variance</th><th>Batch</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.feeExceptions.slice(0, 100).map((fe, i) => (
                      <tr key={i}>
                        <td className="mono">{fe.pg_txn_id}</td>
                        <td className="mono">{fe.order_ref}</td>
                        <td>{fe.payment_method}</td>
                        <td>{fmtINR(fe.gross_amount)}</td>
                        <td>{fmtINR(fe.expected_fee)}</td>
                        <td>{fmtINR(fe.actual_fee)}</td>
                        <td className={fe.variance > 0 ? 'amt-neg' : 'amt-pos'}>{fmtINR(fe.variance)}</td>
                        <td className="mono">{fe.settlement_batch}</td>
                      </tr>
                    ))}
                    {data.feeExceptions.length === 0 && (
                      <tr><td colSpan={8} className="no-data">No fee exceptions found.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════
            SECTION D — Settlements
        ══════════════════════════════════════════════════════════════ */}
        {activeTab === 3 && data && (
          <div className="section">
            <SectionTitle>Settlement Reconciliation</SectionTitle>

            <div className="kpi-grid section-gap">
              <KPICard icon="✅" label="Matched Batches"
                value={data.settlementData.filter(s=>s.status==='matched').length}
                variant="success" valueClass="v-success" />
              <KPICard icon="⚠️" label="Short-paid Batches"
                value={data.settlementData.filter(s=>s.status==='short_paid').length}
                variant="warning" valueClass="v-warning" />
              <KPICard icon="❌" label="Missing Batches"
                value={data.settlementData.filter(s=>s.status==='missing').length}
                variant="danger" valueClass="v-danger" />
              <KPICard icon="📅" label="Outside Bank Period"
                value={data.settlementData.filter(s=>s.status==='outside_period').length}
                sub="Oct+ batches — not missing"
                variant="info" valueClass="v-info" />
              <KPICard icon="⚖️" label="Total Settlement Variance"
                value={fmtINR(data.settlementData.filter(s=>s.status==='short_paid').reduce((s,r)=>s+r.variance,0))}
                variant="warning" valueClass="v-warning" />
            </div>

            <div className="chart-grid cols-1 section-gap">
              <div className="chart-card">
                <div className="chart-title">Expected vs Actual Settlement by Batch</div>
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={data.settlementChartData}
                    margin={{ top: 5, right: 24, left: 24, bottom: 45 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E6E0D5" />
                    <XAxis dataKey="batch" tick={{ fill: '#74776F', fontSize: 9 }}
                      angle={-45} textAnchor="end" />
                    <YAxis tick={{ fill: '#74776F', fontSize: 10 }}
                      tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
                    <Tooltip content={<ChartTooltip />} />
                    <Legend iconType="square" iconSize={10} />
                    <Bar dataKey="expected" name="Expected"      fill="#6F9990" radius={[3,3,0,0]} />
                    <Bar dataKey="actual"   name="Actual Credit" fill="#71866A" radius={[3,3,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="table-wrapper">
              <div className="table-toolbar">
                <h3>Settlement Batch Detail</h3>
                <span className="table-count">{filteredSettlements.length} batches</span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Batch ID</th><th>Settlement Date</th><th>Txns</th><th>Refunds</th>
                      <th>Expected</th><th>Actual Credit</th><th>Variance</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSettlements.map((s, i) => (
                      <tr key={i} className={`stl-${s.status}`}>
                        <td className="mono">{s.batch_id}</td>
                        <td>{s.settlement_date}</td>
                        <td style={{ textAlign: 'center' }}>{s.tx_count}</td>
                        <td style={{ textAlign: 'center' }}>{s.refund_count}</td>
                        <td>{fmtINR(s.expected)}</td>
                        <td>{s.actual > 0 ? fmtINR(s.actual) : '—'}</td>
                        <td className={s.variance === 0 ? '' : s.variance < 0 ? 'amt-neg' : 'amt-pos'}>
                          {s.actual > 0 ? fmtINR(s.variance) : '—'}
                        </td>
                        <td><StatusBadge status={s.status} /></td>
                      </tr>
                    ))}
                    {filteredSettlements.length === 0 && (
                      <tr><td colSpan={8} className="no-data">No settlements match the current filters.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════
            SECTION E — Exceptions
        ══════════════════════════════════════════════════════════════ */}
        {activeTab === 4 && data && (
          <div className="section">
            <SectionTitle>Exception Details</SectionTitle>
            <div className="table-wrapper">
              <div className="table-toolbar">
                <h3>All Exceptions</h3>
                <div className="table-toolbar-right">
                  <span className="table-count">{filteredExceptions.length}</span>
                  <input className="table-search" placeholder="Search order, txn, batch…"
                    value={search} onChange={e => setSearch(e.target.value)} />
                </div>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Category</th><th>Order ID</th><th>Gateway Txn ID</th>
                      <th>Order Status</th><th>Method</th><th>Type</th>
                      <th>Order Amt</th><th>Captured Amt</th>
                      <th>Exp. Fee</th><th>Act. Fee</th><th>Batch</th>
                      <th>Variance</th><th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredExceptions.slice(0, 300).map((ex, i) => (
                      <tr key={i}>
                        <td style={{ minWidth: 160 }}><CatBadge cat={ex.category} /></td>
                        <td className="mono">{ex.order_id}</td>
                        <td className="mono">{ex.pg_txn_id}</td>
                        <td><span className="badge badge-neutral" style={{fontSize:10}}>{ex.order_status || '—'}</span></td>
                        <td>{ex.payment_method}</td>
                        <td>{ex.category === 'No Gateway Capture' ? '—' : <span className="badge badge-neutral">{ex.txn_type}</span>}</td>
                        <td>{ex.order_amount > 0 ? fmtINR(ex.order_amount) : '—'}</td>
                        <td>{ex.captured_amount > 0 ? fmtINR(ex.captured_amount) : '—'}</td>
                        <td>{ex.expected_fee != null ? fmtINR(ex.expected_fee) : '—'}</td>
                        <td>{ex.actual_fee   != null ? fmtINR(ex.actual_fee)   : '—'}</td>
                        <td className="mono">{ex.settlement_batch}</td>
                        <td className={ex.variance === 0 ? '' : ex.variance < 0 ? 'amt-neg' : 'amt-pos'}>
                          {ex.variance !== 0 ? fmtINR(ex.variance) : '—'}
                        </td>
                        <td style={{ minWidth: 200, color: '#74776F', fontSize: 12 }}>{ex.action}</td>
                      </tr>
                    ))}
                    {filteredExceptions.length === 0 && (
                      <tr><td colSpan={13} className="no-data">No exceptions match the current filters.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* Show skeleton message when data not loaded yet but no error */}
        {!data && !loadErr && (
          <div className="no-data">No data available. Run <code>npm run prepare-data</code> first.</div>
        )}

      </div>
    </div>
  );
}
