import { useState, useEffect, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  Cell, PieChart, Pie, Legend
} from "recharts";

const API_BASE = "https://mosaicfellowship.in/api/data/finance";

async function fetchAll(endpoint) {
  let all = [];
  let page = 1;
  let hasNext = true;
  while (hasNext) {
    const res = await fetch(`${API_BASE}/${endpoint}?page=${page}&limit=100`);
    const json = await res.json();
    all = all.concat(json.data);
    hasNext = json.pagination.has_next;
    page++;
  }
  return all;
}

function fmt(n) {
  if (n >= 10000000) return "₹" + (n / 10000000).toFixed(2) + "Cr";
  if (n >= 100000) return "₹" + (n / 100000).toFixed(2) + "L";
  return "₹" + Math.round(n).toLocaleString("en-IN");
}

function fmtFull(n) {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}

function runAudit(lineItems, rateCards, invoices) {
  const rcMap = {};
  rateCards.forEach(r => {
    rcMap[`${r.vendor_id}||${r.item_name}`] = r;
  });

  const invMap = {};
  invoices.forEach(inv => { invMap[inv.invoice_id] = inv; });

  const flags = [];
  const vendorStats = {};

  lineItems.forEach(item => {
    const key = `${item.vendor_id}||${item.item_name}`;
    const rc = rcMap[key];
    const inv = invMap[item.invoice_id];
    const vendor = inv?.vendor_name || item.vendor_id;

    if (!vendorStats[item.vendor_id]) {
      vendorStats[item.vendor_id] = {
        vendor_id: item.vendor_id,
        vendor_name: vendor,
        total_billed: 0,
        total_overcharge: 0,
        flag_count: 0,
      };
    }

    vendorStats[item.vendor_id].total_billed += item.billed_amount;

    // 1. Math error check
    const expected = Math.round(item.quantity * item.unit_price * 100) / 100;
    const diff = Math.abs(expected - item.billed_amount);
    if (diff > 1) {
      const overcharge = item.billed_amount - expected;
      flags.push({
        type: "Math Error",
        invoice_id: item.invoice_id,
        vendor_id: item.vendor_id,
        vendor_name: vendor,
        item_name: item.item_name,
        detail: `Qty ${item.quantity} × ₹${item.unit_price} = ₹${expected.toFixed(2)}, billed ₹${item.billed_amount.toFixed(2)}`,
        overcharge_amount: overcharge,
        severity: Math.abs(overcharge) > 10000 ? "high" : "medium",
        line_id: item.id,
      });
      vendorStats[item.vendor_id].total_overcharge += overcharge;
      vendorStats[item.vendor_id].flag_count++;
    }

    if (!rc) {
      // 5. Unknown item
      flags.push({
        type: "Unknown Item",
        invoice_id: item.invoice_id,
        vendor_id: item.vendor_id,
        vendor_name: vendor,
        item_name: item.item_name,
        detail: `"${item.item_name}" not found in rate card for ${item.vendor_id}`,
        overcharge_amount: item.billed_amount,
        severity: "high",
        line_id: item.id,
      });
      vendorStats[item.vendor_id].total_overcharge += item.billed_amount;
      vendorStats[item.vendor_id].flag_count++;
      return;
    }

    // 2. Rate overcharge
    if (item.unit_price > rc.contracted_rate + 0.01) {
      const overcharge = (item.unit_price - rc.contracted_rate) * item.quantity;
      flags.push({
        type: "Rate Overcharge",
        invoice_id: item.invoice_id,
        vendor_id: item.vendor_id,
        vendor_name: vendor,
        item_name: item.item_name,
        detail: `Billed ₹${item.unit_price}/unit, contracted ₹${rc.contracted_rate}/unit (${item.quantity} units)`,
        overcharge_amount: overcharge,
        severity: overcharge > 50000 ? "high" : "medium",
        line_id: item.id,
      });
      vendorStats[item.vendor_id].total_overcharge += overcharge;
      vendorStats[item.vendor_id].flag_count++;
    }

    // 3. Wrong GST rate
    if (item.billed_gst_rate !== rc.correct_gst_rate) {
      const gstDiff = ((item.billed_gst_rate - rc.correct_gst_rate) / 100) * item.billed_amount;
      flags.push({
        type: "GST Rate Error",
        invoice_id: item.invoice_id,
        vendor_id: item.vendor_id,
        vendor_name: vendor,
        item_name: item.item_name,
        detail: `Billed GST ${item.billed_gst_rate}%, contracted ${rc.correct_gst_rate}% → excess GST ₹${Math.round(gstDiff).toLocaleString("en-IN")}`,
        overcharge_amount: gstDiff,
        severity: gstDiff > 10000 ? "high" : "medium",
        line_id: item.id,
      });
      vendorStats[item.vendor_id].total_overcharge += gstDiff;
      vendorStats[item.vendor_id].flag_count++;
    }
  });

  // 4. Duplicate line items (same invoice, same item, same unit_price)
  const seen = {};
  lineItems.forEach(item => {
    const dupKey = `${item.invoice_id}||${item.item_name}||${item.unit_price}`;
    if (seen[dupKey]) {
      const vendor = invMap[item.invoice_id]?.vendor_name || item.vendor_id;
      flags.push({
        type: "Duplicate Line",
        invoice_id: item.invoice_id,
        vendor_id: item.vendor_id,
        vendor_name: vendor,
        item_name: item.item_name,
        detail: `"${item.item_name}" appears multiple times at same price in ${item.invoice_id}`,
        overcharge_amount: item.billed_amount,
        severity: "high",
        line_id: item.id,
      });
      if (vendorStats[item.vendor_id]) {
        vendorStats[item.vendor_id].total_overcharge += item.billed_amount;
        vendorStats[item.vendor_id].flag_count++;
      }
    } else {
      seen[dupKey] = true;
    }
  });

  const vendorList = Object.values(vendorStats).sort((a, b) => b.total_overcharge - a.total_overcharge);
  const totalOvercharge = vendorList.reduce((s, v) => s + v.total_overcharge, 0);
  const totalBilled = vendorList.reduce((s, v) => s + v.total_billed, 0);

  return { flags, vendorList, totalOvercharge, totalBilled };
}

const TYPE_COLORS = {
  "Rate Overcharge": "#c0392b",
  "GST Rate Error": "#e67e22",
  "Math Error": "#8e44ad",
  "Unknown Item": "#c0392b",
  "Duplicate Line": "#e74c3c",
};

const SEV_COLORS = { high: "#e74c3c", medium: "#e67e22", low: "#27ae60" };

export default function App() {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("All");
  const [filterVendor, setFilterVendor] = useState("All");
  const [sortCol, setSortCol] = useState("overcharge_amount");
  const [sortDir, setSortDir] = useState("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const ROWS_PER_PAGE = 20;

  const runAnalysis = useCallback(async () => {
    setLoading(true);
    setResult(null);
    try {
      setProgress("Fetching invoices (52 pages)...");
      const invoices = await fetchAll("invoices");
      setProgress("Fetching line items (218 pages)...");
      const lineItems = await fetchAll("line-items");
      setProgress("Fetching rate card...");
      const rateCards = await fetchAll("rate-card");
      setProgress("Running audit engine...");
      const res = runAudit(lineItems, rateCards, invoices);
      setResult(res);
    } catch (e) {
      setProgress("Error: " + e.message);
    }
    setLoading(false);
  }, []);

  const tabs = ["overview", "vendors", "flags", "summary"];

  const filteredFlags = result
    ? result.flags
        .filter(f => filterType === "All" || f.type === filterType)
        .filter(f => filterVendor === "All" || f.vendor_name === filterVendor)
        .filter(f =>
          !search ||
          f.item_name.toLowerCase().includes(search.toLowerCase()) ||
          f.invoice_id.toLowerCase().includes(search.toLowerCase()) ||
          f.vendor_name.toLowerCase().includes(search.toLowerCase())
        )
        .sort((a, b) => {
          const va = sortCol === "overcharge_amount" ? a.overcharge_amount : a[sortCol];
          const vb = sortCol === "overcharge_amount" ? b.overcharge_amount : b[sortCol];
          if (typeof va === "string") return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
          return sortDir === "asc" ? va - vb : vb - va;
        })
    : [];

  const paginatedFlags = filteredFlags.slice((currentPage - 1) * ROWS_PER_PAGE, currentPage * ROWS_PER_PAGE);
  const totalPages = Math.ceil(filteredFlags.length / ROWS_PER_PAGE);

  const typeBreakdown = result
    ? Object.entries(
        result.flags.reduce((acc, f) => {
          acc[f.type] = (acc[f.type] || 0) + 1;
          return acc;
        }, {})
      ).map(([name, value]) => ({ name, value }))
    : [];

  const vendorChartData = result
    ? result.vendorList
        .filter(v => v.total_overcharge > 0)
        .slice(0, 10)
        .map(v => ({ name: v.vendor_name.split(" ")[0], overcharge: Math.round(v.total_overcharge), flags: v.flag_count }))
    : [];

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="brand">
            <div className="brand-icon">⚡</div>
            <div>
              <div className="brand-name">Invoice Audit Intelligence</div>
              <div className="brand-sub">Mosaic Wellness · Vendor Billing Analysis</div>
            </div>
          </div>
          <button className="run-btn" onClick={runAnalysis} disabled={loading}>
            {loading ? <span className="spinner" /> : null}
            {loading ? progress : "Run Full Audit"}
          </button>
        </div>
      </header>

      {!result && !loading && (
        <div className="landing">
          <div className="landing-card">
            <div className="landing-icon">🔍</div>
            <h1>CFO Briefing: Vendor Overcharge Audit</h1>
            <p>
              Automated cross-reference of <strong>21,800+ invoice line items</strong> across 15 vendors
              against contracted rate cards. Detects rate overcharges, GST errors, math discrepancies,
              duplicate billing, and unknown items.
            </p>
            <div className="checks-grid">
              {["Rate vs. Contract", "GST Rate Accuracy", "Math Verification", "Duplicate Detection", "Unknown Items", "Invoice Totals"].map(c => (
                <div key={c} className="check-pill">
                  <span className="check-dot" />
                  {c}
                </div>
              ))}
            </div>
            <button className="run-btn-lg" onClick={runAnalysis}>
              Start Audit — Fetch All Data
            </button>
            <p className="landing-note">Fetches ~270 pages across 3 API endpoints. Takes ~2–3 minutes.</p>
          </div>
        </div>
      )}

      {loading && (
        <div className="loading-screen">
          <div className="loading-card">
            <div className="loading-spinner-lg" />
            <div className="loading-text">{progress}</div>
            <div className="loading-sub">Processing thousands of line items…</div>
          </div>
        </div>
      )}

      {result && (
        <div className="dashboard">
          <div className="stat-row">
            <StatCard
              label="Total Overcharge Identified"
              value={fmt(result.totalOvercharge)}
              sub={`${((result.totalOvercharge / result.totalBilled) * 100).toFixed(2)}% of total billed`}
              accent="red"
            />
            <StatCard
              label="Total Billed by Vendors"
              value={fmt(result.totalBilled)}
              sub={`Across ${result.vendorList.length} vendors`}
              accent="blue"
            />
            <StatCard
              label="Total Flags Raised"
              value={result.flags.length.toLocaleString()}
              sub={`${result.flags.filter(f => f.severity === "high").length} high severity`}
              accent="orange"
            />
            <StatCard
              label="Vendors with Issues"
              value={result.vendorList.filter(v => v.total_overcharge > 0).length}
              sub={`Out of ${result.vendorList.length} total vendors`}
              accent="purple"
            />
          </div>

          <div className="tabs">
            {tabs.map(t => (
              <button
                key={t}
                className={`tab-btn ${activeTab === t ? "active" : ""}`}
                onClick={() => setActiveTab(t)}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {activeTab === "overview" && (
            <div className="tab-content">
              <div className="charts-grid">
                <div className="chart-card">
                  <div className="chart-title">Overcharge by Vendor (Top 10)</div>
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={vendorChartData} margin={{ top: 8, right: 16, left: 0, bottom: 60 }}>
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#666" }} angle={-35} textAnchor="end" />
                      <YAxis tickFormatter={v => fmt(v)} tick={{ fontSize: 11, fill: "#666" }} width={80} />
                      <Tooltip formatter={(v) => [fmtFull(v), "Overcharge"]} />
                      <Bar dataKey="overcharge" radius={[4, 4, 0, 0]}>
                        {vendorChartData.map((_, i) => (
                          <Cell key={i} fill={i === 0 ? "#c0392b" : i === 1 ? "#e74c3c" : i === 2 ? "#e67e22" : "#f39c12"} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div className="chart-card">
                  <div className="chart-title">Flag Types Breakdown</div>
                  <ResponsiveContainer width="100%" height={320}>
                    <PieChart>
                      <Pie
                        data={typeBreakdown}
                        cx="50%"
                        cy="50%"
                        outerRadius={110}
                        dataKey="value"
                        label={({ name, percent }) => `${name.split(" ")[0]} ${(percent * 100).toFixed(0)}%`}
                        labelLine={false}
                        fontSize={11}
                      >
                        {typeBreakdown.map((entry, i) => (
                          <Cell key={i} fill={TYPE_COLORS[entry.name] || "#95a5a6"} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="top-offenders">
                <div className="section-title">Top 5 Vendors by Overcharge Amount</div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Vendor</th>
                      <th>Total Billed</th>
                      <th>Overcharge</th>
                      <th>Overcharge %</th>
                      <th>Flags</th>
                      <th>Risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.vendorList.filter(v => v.total_overcharge > 0).slice(0, 5).map(v => (
                      <tr key={v.vendor_id}>
                        <td><strong>{v.vendor_name}</strong></td>
                        <td>{fmt(v.total_billed)}</td>
                        <td className="red">{fmt(v.total_overcharge)}</td>
                        <td className="red">{((v.total_overcharge / v.total_billed) * 100).toFixed(2)}%</td>
                        <td>{v.flag_count}</td>
                        <td>
                          <span className={`badge ${v.total_overcharge > 1000000 ? "badge-red" : v.total_overcharge > 100000 ? "badge-orange" : "badge-yellow"}`}>
                            {v.total_overcharge > 1000000 ? "Critical" : v.total_overcharge > 100000 ? "High" : "Medium"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === "vendors" && (
            <div className="tab-content">
              <div className="section-title">All Vendors — Billing & Overcharge Analysis</div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th>ID</th>
                    <th>Total Billed</th>
                    <th>Overcharge</th>
                    <th>Overcharge %</th>
                    <th>Flags</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.vendorList.map(v => (
                    <tr key={v.vendor_id} className={v.total_overcharge > 0 ? "row-flagged" : ""}>
                      <td><strong>{v.vendor_name}</strong></td>
                      <td className="mono">{v.vendor_id}</td>
                      <td>{fmt(v.total_billed)}</td>
                      <td className={v.total_overcharge > 0 ? "red" : "green"}>
                        {v.total_overcharge > 0 ? fmt(v.total_overcharge) : "✓ Clean"}
                      </td>
                      <td className={v.total_overcharge > 0 ? "red" : ""}>
                        {v.total_overcharge > 0 ? ((v.total_overcharge / v.total_billed) * 100).toFixed(2) + "%" : "—"}
                      </td>
                      <td>{v.flag_count || "—"}</td>
                      <td>
                        {v.total_overcharge === 0
                          ? <span className="badge badge-green">Clean</span>
                          : v.total_overcharge > 1000000
                          ? <span className="badge badge-red">Critical</span>
                          : v.total_overcharge > 100000
                          ? <span className="badge badge-orange">High Risk</span>
                          : <span className="badge badge-yellow">Medium</span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "flags" && (
            <div className="tab-content">
              <div className="filter-bar">
                <input
                  className="search-input"
                  placeholder="Search invoice, vendor, item..."
                  value={search}
                  onChange={e => { setSearch(e.target.value); setCurrentPage(1); }}
                />
                <select
                  className="filter-select"
                  value={filterType}
                  onChange={e => { setFilterType(e.target.value); setCurrentPage(1); }}
                >
                  <option>All</option>
                  {[...new Set(result.flags.map(f => f.type))].map(t => <option key={t}>{t}</option>)}
                </select>
                <select
                  className="filter-select"
                  value={filterVendor}
                  onChange={e => { setFilterVendor(e.target.value); setCurrentPage(1); }}
                >
                  <option>All</option>
                  {[...new Set(result.flags.map(f => f.vendor_name))].sort().map(v => <option key={v}>{v}</option>)}
                </select>
                <div className="flag-count">{filteredFlags.length.toLocaleString()} flags</div>
              </div>

              <table className="data-table flags-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Invoice</th>
                    <th>Vendor</th>
                    <th>Item</th>
                    <th>Detail</th>
                    <th
                      style={{ cursor: "pointer" }}
                      onClick={() => {
                        if (sortCol === "overcharge_amount") setSortDir(d => d === "asc" ? "desc" : "asc");
                        else { setSortCol("overcharge_amount"); setSortDir("desc"); }
                      }}
                    >
                      Overcharge {sortCol === "overcharge_amount" ? (sortDir === "desc" ? "↓" : "↑") : "↕"}
                    </th>
                    <th>Severity</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedFlags.map((f, i) => (
                    <tr key={i} className={`sev-${f.severity}`}>
                      <td>
                        <span className="flag-type-badge" style={{ background: TYPE_COLORS[f.type] + "22", color: TYPE_COLORS[f.type], borderColor: TYPE_COLORS[f.type] + "44" }}>
                          {f.type}
                        </span>
                      </td>
                      <td className="mono">{f.invoice_id}</td>
                      <td>{f.vendor_name}</td>
                      <td>{f.item_name}</td>
                      <td className="detail-cell">{f.detail}</td>
                      <td className={f.overcharge_amount > 0 ? "red" : "green"}>
                        {f.overcharge_amount > 0 ? fmt(f.overcharge_amount) : `(${fmt(Math.abs(f.overcharge_amount))})`}
                      </td>
                      <td>
                        <span className={`badge badge-${f.severity === "high" ? "red" : f.severity === "medium" ? "orange" : "yellow"}`}>
                          {f.severity}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {totalPages > 1 && (
                <div className="pagination">
                  <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}>←</button>
                  <span>Page {currentPage} of {totalPages}</span>
                  <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}>→</button>
                </div>
              )}
            </div>
          )}

          {activeTab === "summary" && (
            <div className="tab-content">
              <div className="summary-card">
                <h2>📋 CFO Briefing — Executive Summary</h2>
                <p>
                  Our automated audit of <strong>{result.flags.length.toLocaleString()} discrepancies</strong> across all vendor invoices
                  identified a total overcharge of <strong className="red-text">{fmtFull(result.totalOvercharge)}</strong> against
                  a total vendor spend of {fmtFull(result.totalBilled)}.
                  This represents <strong className="red-text">{((result.totalOvercharge / result.totalBilled) * 100).toFixed(2)}%</strong> of total
                  billed amount — well above the acceptable 0.5% tolerance.
                </p>

                <h3>Key Findings</h3>
                <div className="findings-grid">
                  {result.vendorList.filter(v => v.total_overcharge > 0).slice(0, 6).map(v => (
                    <div key={v.vendor_id} className="finding-card">
                      <div className="finding-vendor">{v.vendor_name}</div>
                      <div className="finding-amount red-text">{fmt(v.total_overcharge)}</div>
                      <div className="finding-detail">{v.flag_count} flags · {((v.total_overcharge / v.total_billed) * 100).toFixed(1)}% overbilled</div>
                    </div>
                  ))}
                </div>

                <h3>Flag Breakdown</h3>
                <table className="data-table">
                  <thead><tr><th>Type</th><th>Count</th><th>Description</th></tr></thead>
                  <tbody>
                    {typeBreakdown.map(t => (
                      <tr key={t.name}>
                        <td><span className="flag-type-badge" style={{ background: TYPE_COLORS[t.name] + "22", color: TYPE_COLORS[t.name], borderColor: TYPE_COLORS[t.name] + "44" }}>{t.name}</span></td>
                        <td>{t.value}</td>
                        <td className="detail-cell">{
                          t.name === "Rate Overcharge" ? "Vendor billed above contracted unit rate" :
                          t.name === "GST Rate Error" ? "GST% applied differs from contracted rate" :
                          t.name === "Math Error" ? "Qty × unit price ≠ line total" :
                          t.name === "Duplicate Line" ? "Same item billed multiple times in one invoice" :
                          "Item not in rate card — no contracted rate exists"
                        }</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <h3>Recommendations</h3>
                <ol className="recommendations">
                  <li>
                    <strong>Immediate action:</strong> Raise debit notes against the top 3 vendors
                    ({result.vendorList.filter(v => v.total_overcharge > 0).slice(0, 3).map(v => v.vendor_name).join(", ")}).
                    These three alone account for the majority of identified overcharges.
                  </li>
                  <li>
                    <strong>System fix:</strong> Implement pre-payment rate validation — no invoice should be
                    approved if any line item exceeds the contracted rate by more than 0.1%.
                  </li>
                  <li>
                    <strong>Contract audit:</strong> Review rate cards for items flagged as "Unknown" — either update
                    the rate card or reject those line items during approval.
                  </li>
                  <li>
                    <strong>GST compliance:</strong> All GST rate mismatches should be flagged to the accounts team —
                    incorrect GST rates create compliance risk beyond just the financial overcharge.
                  </li>
                  <li>
                    <strong>Monthly running:</strong> Schedule this audit to run automatically at month-end before
                    payment runs, not after. Catching issues before payment is far more effective than recovery.
                  </li>
                </ol>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div className={`stat-card stat-${accent}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}
