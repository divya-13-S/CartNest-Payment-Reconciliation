// FiltersBar.jsx
export default function FiltersBar({ filters, onChange, onReset, paymentMethods }) {
  return (
    <div className="filters-bar">
      <div className="filter-group">
        <label>From Date</label>
        <input
          type="date"
          value={filters.dateFrom}
          onChange={e => onChange({ ...filters, dateFrom: e.target.value })}
        />
      </div>
      <div className="filter-group">
        <label>To Date</label>
        <input
          type="date"
          value={filters.dateTo}
          onChange={e => onChange({ ...filters, dateTo: e.target.value })}
        />
      </div>
      <div className="filter-group">
        <label>Payment Method</label>
        <select
          value={filters.paymentMethod}
          onChange={e => onChange({ ...filters, paymentMethod: e.target.value })}
        >
          <option value="">All Methods</option>
          {paymentMethods.map(pm => (
            <option key={pm} value={pm}>{pm}</option>
          ))}
        </select>
      </div>
      <div className="filter-group">
        <label>Transaction Type</label>
        <select
          value={filters.txnType}
          onChange={e => onChange({ ...filters, txnType: e.target.value })}
        >
          <option value="">All Types</option>
          <option value="CAPTURE">Capture</option>
          <option value="REFUND">Refund</option>
        </select>
      </div>
      <div className="filter-group">
        <label>Exception Category</label>
        <select
          value={filters.exceptionCategory}
          onChange={e => onChange({ ...filters, exceptionCategory: e.target.value })}
        >
          <option value="">All Exceptions</option>
          <option value="No Gateway Capture">No Capture</option>
          <option value="Amount Mismatch">Amount Mismatch</option>
          <option value="Unmatched Capture">Unmatched Capture</option>
          <option value="Fee Variance">Fee Variance</option>
          <option value="Missing Settlement">Missing Settlement</option>
          <option value="Short Settlement">Short Settlement</option>
        </select>
      </div>
      <div className="filter-group">
        <label>Settlement Status</label>
        <select
          value={filters.settlementStatus}
          onChange={e => onChange({ ...filters, settlementStatus: e.target.value })}
        >
          <option value="">All</option>
          <option value="matched">Matched</option>
          <option value="short_paid">Short-paid</option>
          <option value="missing">Missing</option>
          <option value="outside_period">Outside Period</option>
        </select>
      </div>
      <button className="reset-btn" onClick={onReset}>↺ Reset</button>
    </div>
  );
}
