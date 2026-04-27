import { useMemo, useRef, useState } from "react";

// Prospecting Engine results loader.
// User runs the local pipeline (private repo), drops the JSON output here.
// Zero API calls, zero data committed to repo — real data stays local.

const PROSPECT_TIERS = { A: 65, B: 50, C: 40 };

const PRIORITY_STYLES = {
  IMMEDIATE: "bg-red-100 text-red-800",
  HIGH:      "bg-orange-100 text-orange-800",
  MEDIUM:    "bg-blue-100 text-blue-800",
  PIPELINE:  "bg-gray-100 text-gray-700",
};

const TIER_STYLES = {
  A: "bg-green-100 text-green-800",
  B: "bg-blue-100 text-blue-800",
  C: "bg-gray-100 text-gray-700",
  D: "bg-gray-100 text-gray-500",
};

const DEGREE_LABEL = { 1: "1st", 2: "2nd", 3: "3rd" };

function classify(c) {
  if (typeof c.tier === "string" && c.tier) return c.tier;
  const ops = c.ops_score ?? 0;
  if (ops >= PROSPECT_TIERS.A) return "A";
  if (ops >= PROSPECT_TIERS.B) return "B";
  if (ops >= PROSPECT_TIERS.C) return "C";
  return "D";
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function splitName(full) {
  const toks = (full || "").trim().split(/\s+/);
  if (toks.length <= 1) return [toks[0] || "", ""];
  return [toks.slice(0, -1).join(" "), toks[toks.length - 1]];
}

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function rowsToCsv(rows, headers) {
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape(r[h])).join(","));
  }
  return lines.join("\n");
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

// ── Component ──────────────────────────────────────────────────────────

export default function Prospecting() {
  const [prospects, setProspects] = useState([]);
  const [stats, setStats] = useState(null);
  const [filterTier, setFilterTier] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterDegree, setFilterDegree] = useState("all");
  const [searchText, setSearchText] = useState("");
  const [sortField, setSortField] = useState("ops_score");
  const [sortDir, setSortDir] = useState("desc");
  const [selectedProspect, setSelectedProspect] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef(null);

  function computeStats(data) {
    let A = 0, B = 0, C = 0, confirmed = 0;
    for (const c of data) {
      const t = classify(c);
      if (t === "A") A++;
      else if (t === "B") B++;
      else if (t === "C") C++;
      if (c.status === "Confirmed") confirmed++;
    }
    return { tierA: A, tierB: B, tierC: C, confirmed, total: data.length };
  }

  function ingest(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError("Invalid JSON file");
      return;
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0].ops_score !== "number") {
      setError("Invalid prospecting output file (expected array with ops_score field)");
      return;
    }
    setError("");
    setProspects(parsed);
    setStats(computeStats(parsed));
  }

  function handleFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => ingest(e.target.result);
    reader.onerror = () => setError("Failed to read file");
    reader.readAsText(file);
  }

  function handleDrop(e) {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  }

  function clearResults() {
    setProspects([]);
    setStats(null);
    setSelectedProspect(null);
    setError("");
  }

  // ── Filtered + sorted view ─────────────────────────────────────────
  const visible = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    let rows = prospects.filter((c) => {
      if (filterTier !== "all" && classify(c) !== filterTier) return false;
      if (filterStatus !== "all" && c.status !== filterStatus) return false;
      if (filterDegree !== "all" && String(c.degree) !== filterDegree) return false;
      if (q) {
        const name = (c.display_name || "").toLowerCase();
        const inst = (c.institution || "").toLowerCase();
        if (!name.includes(q) && !inst.includes(q)) return false;
      }
      return true;
    });

    rows = rows.slice().sort((a, b) => {
      // Confirmed always pinned to top regardless of sort
      const aC = a.status === "Confirmed" ? 0 : 1;
      const bC = b.status === "Confirmed" ? 0 : 1;
      if (aC !== bC) return aC - bC;
      const va = a[sortField];
      const vb = b[sortField];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") {
        return sortDir === "asc" ? va - vb : vb - va;
      }
      const sa = String(va).toLowerCase();
      const sb = String(vb).toLowerCase();
      if (sa < sb) return sortDir === "asc" ? -1 : 1;
      if (sa > sb) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return rows;
  }, [prospects, filterTier, filterStatus, filterDegree, searchText, sortField, sortDir]);

  function toggleSort(field) {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  }

  // ── Exports ───────────────────────────────────────────────────────
  function exportCsv() {
    const headers = [
      "First Name", "Last Name", "Institution",
      "OPS Score", "Tier", "Status", "Priority",
      "Connection Path", "Degree", "NIH Funded", "RCT Count",
    ];
    const rows = visible.map((c) => {
      const [first, last] = splitName(c.display_name);
      return {
        "First Name": first,
        "Last Name": last,
        "Institution": c.institution || "",
        "OPS Score": c.ops_score ?? "",
        "Tier": classify(c),
        "Status": c.status || "",
        "Priority": c.priority || "",
        "Connection Path": c.connection_path || "",
        "Degree": c.degree ?? "",
        "NIH Funded": c.nih_funded ? "Yes" : "No",
        "RCT Count": c.rct_count ?? 0,
      };
    });
    downloadBlob(rowsToCsv(rows, headers), `prospects_hubspot_${todayStamp()}.csv`, "text/csv");
  }

  function exportJson() {
    downloadBlob(JSON.stringify(prospects, null, 2), `prospects_full_${todayStamp()}.json`, "application/json");
  }

  // ── Render: upload panel ───────────────────────────────────────────
  if (prospects.length === 0) {
    return (
      <div className="h-full flex items-center justify-center p-6 bg-gray-50">
        <div
          className={`w-full max-w-2xl rounded-lg border-2 border-dashed p-12 text-center transition-colors ${
            isDragging ? "border-teal-primary bg-teal-light/40" : "border-gray-300 bg-white"
          }`}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          <div className="text-5xl mb-3">📊</div>
          <h2 className="text-lg font-semibold text-gray-800 mb-1">Load Prospecting Results</h2>
          <p className="text-sm text-gray-600 mb-4">
            Upload the JSON output from your local prospecting pipeline run
          </p>
          <code className="block text-xs bg-gray-100 text-gray-700 px-3 py-2 rounded mb-6 font-mono">
            python -m prospecting.pipeline --dois &lt;doi1&gt; &lt;doi2&gt;
          </code>
          <div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-4 py-2 bg-teal-primary text-white text-sm font-medium rounded hover:bg-teal-dark transition-colors"
            >
              Choose JSON file
            </button>
            <p className="text-xs text-gray-500 mt-2">or drag & drop a file here</p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          {error && (
            <p className="mt-4 text-sm text-red-600 font-medium">{error}</p>
          )}
        </div>
      </div>
    );
  }

  // ── Render: results view ───────────────────────────────────────────
  const SortHeader = ({ label, field, align = "left", className = "" }) => {
    const active = sortField === field;
    return (
      <th
        onClick={() => toggleSort(field)}
        className={`px-3 py-2 text-${align} text-xs font-semibold text-gray-600 cursor-pointer hover:text-teal-primary select-none ${className}`}
      >
        {label}
        {active && <span className="ml-1 text-teal-primary">{sortDir === "asc" ? "↑" : "↓"}</span>}
      </th>
    );
  };

  return (
    <div className="h-full flex bg-gray-50 overflow-hidden">
      <div className="flex-1 flex flex-col p-4 gap-3 overflow-hidden">
        {/* Stats bar */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs px-2 py-1 rounded bg-green-100 text-green-800 font-semibold">
            {stats.tierA} Tier A
          </span>
          <span className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-800 font-semibold">
            {stats.tierB} Tier B
          </span>
          <span className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-700 font-semibold">
            {stats.tierC} Tier C
          </span>
          {stats.confirmed > 0 && (
            <span className="text-xs px-2 py-1 rounded bg-yellow-100 text-yellow-800 font-semibold">
              {stats.confirmed} Confirmed
            </span>
          )}
          <span className="text-xs text-gray-500 ml-2">
            {stats.total} total scored
          </span>
          <button
            onClick={clearResults}
            className="ml-auto text-xs text-gray-500 hover:text-teal-primary underline"
          >
            Clear results
          </button>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <FilterGroup label="Tier" value={filterTier} setValue={setFilterTier} options={[
            { v: "all", l: "All" }, { v: "A", l: "A" }, { v: "B", l: "B" }, { v: "C", l: "C" },
          ]} />
          <FilterGroup label="Status" value={filterStatus} setValue={setFilterStatus} options={[
            { v: "all", l: "All" }, { v: "Confirmed", l: "Confirmed" }, { v: "Prospective", l: "Prospective" },
          ]} />
          <FilterGroup label="Degree" value={filterDegree} setValue={setFilterDegree} options={[
            { v: "all", l: "All" }, { v: "1", l: "1st" }, { v: "2", l: "2nd" }, { v: "3", l: "3rd" },
          ]} />
          <input
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search name or institution…"
            className="border border-gray-300 rounded px-3 py-1.5 text-sm w-64 focus:outline-none focus:border-teal-primary"
          />
          <span className="ml-auto text-xs text-gray-500">
            {visible.length} match{visible.length === 1 ? "" : "es"}
          </span>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto border border-gray-200 rounded-lg bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <SortHeader label="Priority" field="priority" />
                <SortHeader label="Name / Institution" field="display_name" />
                <SortHeader label="Tier" field="tier" />
                <SortHeader label="OPS" field="ops_score" align="right" />
                <SortHeader label="Deg" field="degree" />
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">Connection</th>
                <SortHeader label="NIH" field="nih_funded" />
                <SortHeader label="RCTs" field="rct_count" align="right" />
                <SortHeader label="Status" field="status" />
              </tr>
            </thead>
            <tbody>
              {visible.map((c, i) => {
                const tier = classify(c);
                return (
                  <tr
                    key={c.author_id || i}
                    onClick={() => setSelectedProspect(c)}
                    className="border-t border-gray-100 hover:bg-teal-light/40 cursor-pointer"
                  >
                    <td className="px-3 py-1.5">
                      {c.priority && (
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${PRIORITY_STYLES[c.priority] || "bg-gray-100 text-gray-600"}`}>
                          {c.priority}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="font-medium text-gray-900">{c.display_name || "—"}</div>
                      <div className="text-xs text-gray-500">{c.institution || "—"}</div>
                    </td>
                    <td className="px-3 py-1.5">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${TIER_STYLES[tier] || "bg-gray-100"}`}>
                        {tier}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-semibold text-gray-900">
                      {(c.ops_score ?? 0).toFixed(1)}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-gray-500">{DEGREE_LABEL[c.degree] || ""}</td>
                    <td
                      className="px-3 py-1.5 text-xs text-gray-600"
                      title={c.connection_path || ""}
                    >
                      {truncate(c.connection_path || "", 55)}
                    </td>
                    <td className="px-3 py-1.5 text-xs">
                      {c.nih_funded ? <span className="text-green-600 font-bold">✓</span> : ""}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-right">
                      {c.rct_count ? c.rct_count : ""}
                    </td>
                    <td className="px-3 py-1.5 text-xs">
                      {c.status === "Confirmed"
                        ? <span className="text-green-600">🟢 Confirmed</span>
                        : <span className="text-blue-600">🔵 Prospective</span>}
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-gray-400 text-sm">
                    No prospects match your filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Export controls */}
        <div className="flex gap-2">
          <button
            onClick={exportCsv}
            className="px-3 py-1.5 text-sm bg-teal-primary text-white rounded hover:bg-teal-dark transition-colors"
          >
            Export HubSpot CSV ({visible.length})
          </button>
          <button
            onClick={exportJson}
            className="px-3 py-1.5 text-sm bg-white border border-gray-300 text-gray-700 rounded hover:bg-gray-50 transition-colors"
          >
            Export Full JSON ({prospects.length})
          </button>
        </div>
      </div>

      {/* Detail panel */}
      {selectedProspect && (
        <DetailPanel
          prospect={selectedProspect}
          tier={classify(selectedProspect)}
          onClose={() => setSelectedProspect(null)}
        />
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────

function FilterGroup({ label, value, setValue, options }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-gray-500 mr-1">{label}:</span>
      <div className="flex bg-gray-100 rounded p-0.5">
        {options.map((o) => (
          <button
            key={o.v}
            onClick={() => setValue(o.v)}
            className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
              value === o.v
                ? "bg-white text-teal-primary shadow-sm"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            {o.l}
          </button>
        ))}
      </div>
    </div>
  );
}

function DetailPanel({ prospect: c, tier, onClose }) {
  const profile = c.openalex_profile || {};
  return (
    <div className="w-96 bg-white border-l border-gray-200 overflow-auto shrink-0 relative">
      <button
        onClick={onClose}
        className="absolute top-3 right-3 text-gray-400 hover:text-gray-700 text-xl leading-none"
        aria-label="Close"
      >
        ×
      </button>
      <div className="p-5">
        <h2 className="text-lg font-bold text-gray-900 leading-tight mb-1">
          {c.display_name || "—"}
        </h2>
        <p className="text-sm text-gray-600 mb-3">
          {c.institution || "—"}
        </p>

        <div className="flex gap-2 mb-4">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${TIER_STYLES[tier] || "bg-gray-100"}`}>
            Tier {tier}
          </span>
          {c.priority && (
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${PRIORITY_STYLES[c.priority] || "bg-gray-100"}`}>
              {c.priority}
            </span>
          )}
          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-gray-100 text-gray-700">
            {c.status === "Confirmed" ? "🟢 Confirmed" : "🔵 Prospective"}
          </span>
        </div>

        <div className="bg-teal-light/40 border border-teal-primary/20 rounded p-3 mb-4">
          <div className="text-3xl font-bold text-teal-primary">
            {(c.ops_score ?? 0).toFixed(1)}
            <span className="text-sm font-normal text-gray-500 ml-1">/ 100</span>
          </div>
          <div className="text-xs text-gray-600">OPS Composite Score</div>
        </div>

        <h3 className="text-xs font-bold uppercase text-gray-500 mb-2">Score breakdown</h3>
        <div className="space-y-1.5 text-sm mb-4">
          <ScoreRow label="Institutional Credibility" value={c.institutional_credibility_score} />
          <ScoreRow label="Clinical Relevance" value={c.clinical_relevance_score} />
          <ScoreRow label="Collaboration Signal" value={c.collaboration_signal_score} reason={c.collaboration_reason} />
          <ScoreRow label="Nutrition Openness" value={c.nutrition_openness_score} />
          <ScoreRow label="Strategic Reach" value={c.strategic_reach_score} />
        </div>

        <hr className="my-4 border-gray-200" />

        <h3 className="text-xs font-bold uppercase text-gray-500 mb-2">Connection</h3>
        <p className="text-xs text-gray-700 mb-2 leading-relaxed">
          {c.connection_path || "—"}
        </p>
        <p className="text-xs text-gray-500 mb-1">
          {DEGREE_LABEL[c.degree] || "—"} degree connection
        </p>
        {c.source_doi && (
          <p className="text-xs text-gray-500">
            Source: <span className="font-mono">{c.source_doi}</span>
          </p>
        )}

        <hr className="my-4 border-gray-200" />

        <h3 className="text-xs font-bold uppercase text-gray-500 mb-2">PubMed data</h3>
        <div className="space-y-1 text-xs text-gray-700">
          <Field label="Publications (last 50)" value={c.recent_pub_count_pubmed ?? 0} />
          <Field label="Primary MeSH hits" value={c.primary_mesh_hits ?? 0} />
          <Field label="Secondary MeSH hits" value={c.secondary_mesh_hits ?? 0} />
          <Field label="NIH funded" value={c.nih_funded ? "Yes" : "No"} />
          <Field label="RCT count" value={c.rct_count ?? 0} />
          <Field label="Clinical trials" value={c.clinical_trial_count ?? 0} />
          {c.pubmed_institution_cleaned && (
            <Field label="Institution (PubMed)" value={c.pubmed_institution_cleaned} />
          )}
          {profile.h_index != null && (
            <Field label="h-index (OpenAlex)" value={profile.h_index} />
          )}
          {profile.citation_count != null && (
            <Field label="Citations (OpenAlex)" value={profile.citation_count.toLocaleString()} />
          )}
        </div>
      </div>
    </div>
  );
}

function ScoreRow({ label, value, reason }) {
  const v = value ?? 0;
  const pct = Math.min(100, (v / 20) * 100);
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-gray-700">{label}</span>
        <span className="font-medium text-gray-900">{v.toFixed(1)} / 20</span>
      </div>
      <div className="h-1 bg-gray-100 rounded mt-0.5">
        <div className="h-1 bg-teal-primary rounded" style={{ width: `${pct}%` }} />
      </div>
      {reason && <div className="text-[10px] text-gray-500 mt-0.5">{reason}</div>}
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-900 font-medium text-right">{value}</span>
    </div>
  );
}
