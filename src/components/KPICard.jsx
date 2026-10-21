// KPICard.jsx
export default function KPICard({ label, value, sub, icon, variant = '' }) {
  return (
    <div className={`kpi-card ${variant}`}>
      {icon && <div className="kpi-icon">{icon}</div>}
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${variant}`}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}
