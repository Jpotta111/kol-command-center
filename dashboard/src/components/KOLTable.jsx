import { useState, useMemo } from "react";
import Papa from "papaparse";

const TIER_COLORS = { A: "#22c55e", B: "#3b82f6", C: "#eab308", D: "#9ca3af" };

const HUBSPOT_COLUMNS = [
  "hs_object_id", "ops_score", "kol_tier", "scientific_influence_score",
  "clinical_alignment_score", "pharma_entanglement_score", "openalex_id",
  "orcid", "top_paper_title", "top_paper_doi", "h_index", "citation_count",
  "institution", "nutrition_signal_keywords", "last_profiled_date",
  "nutrition_stance", "nutrition_stance_source",
];

function downloadCSV(rows, filename) {
  const csv = Papa.unparse(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function KOLTable({ nodes, profiles, onSelectKOL, kolMode = "All", pipelineContacts }) {
  const isCommercial = kolMode === "Commercial";
  const [sortKey, setSortKey] = useState(isCommercial ? "confirmed_organization" : "ops_score");
  const [sortAsc, setSortAsc] = useState(false);
  const [tierFilter, setTierFilter] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set());

  // In commercial mode, use pipelineContacts filtered to commercial KOL Type
  const commercialContacts = (pipelineContacts || []).filter((c) => {
    const kt = (c["KOL Type"] || c.kol_type || "").toLowerCase();
    return kt === "commercial";
  });

  const profileMap = useMemo(() => {
    const m = {};
    for (const p of profiles) {
      if (p._meta?.openalex_id) m[p._meta.openalex_id] = p;
    }
    return m;
  }, [profiles]);

  const filtered = useMemo(() => {
    let rows = [...nodes];
    if (tierFilter) rows = rows.filter((r) => r.tier === tierFilter);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.display_name.toLowerCase().includes(q) ||
          (r.institution || "").toLowerCase().includes(q)
      );
    }
    rows.sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      if (typeof av === "string") return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortAsc ? av - bv : bv - av;
    });
    return rows;
  }, [nodes, tierFilter, search, sortKey, sortAsc]);

  const reengageQueue = useMemo(() => {
    return nodes.filter((n) => {
      if (n.tier !== "A" && n.tier !== "B") return false;
      const prof = profileMap[n.openalex_id];
      const stance = prof?.nutrition_stance_assessment;
      const level = typeof stance === "object" ? stance?.level : stance;
      return level !== "LOW";
    });
  }, [nodes, profileMap]);

  function handleSort(key) {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(false);
    }
  }

  function toggleSelect(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((r) => r.openalex_id)));
    }
  }

  function exportSelected() {
    const rows = filtered
      .filter((r) => selected.has(r.openalex_id))
      .map((r) => ({
        hs_object_id: "",
        ops_score: r.ops_score,
        kol_tier: r.tier,
        scientific_influence_score: r.scientific_influence_score,
        clinical_alignment_score: r.clinical_alignment_score,
        pharma_entanglement_score: r.strategic_value_score,
        openalex_id: r.openalex_id,
        orcid: "",
        top_paper_title: "",
        top_paper_doi: "",
        h_index: r.h_index,
        citation_count: r.citation_count,
        institution: r.institution || "",
        nutrition_signal_keywords: "",
        last_profiled_date: new Date().toISOString().split("T")[0],
        nutrition_stance: "",
        nutrition_stance_source: "",
      }));
    downloadCSV(rows, "kol_hubspot_export.csv");
  }

  const SortHeader = ({ label, field, className = "" }) => (
    <th
      onClick={() => handleSort(field)}
      className={`px-3 py-2 text-left text-xs font-semibold text-gray-600 cursor-pointer hover:text-teal-primary select-none ${className}`}
    >
      {label} {sortKey === field ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
    </th>
  );

  // ── Commercial table view ─────────────────────────────────────────────
  if (isCommercial) {
    const commFiltered = commercialContacts.filter((c) => {
      if (!search) return true;
      const q = search.toLowerCase();
      const name = (c.display_name || c.name || `${c.firstname || ""} ${c.lastname || ""}`.trim()).toLowerCase();
      const org = (c.confirmed_organization || c.company || c.Company || "").toLowerCase();
      return name.includes(q) || org.includes(q);
    });

    const confColor = { HIGH: "bg-green-100 text-green-800", MEDIUM: "bg-yellow-100 text-yellow-800", LOW: "bg-red-100 text-red-800" };

    return (
      <div className="h-full flex flex-col p-4 gap-3 overflow-hidden">
        <div className="flex items-center gap-3">
          <input type="text" placeholder="Search name or organization..." value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border border-gray-300 rounded px-3 py-1.5 text-sm w-64 focus:outline-none focus:border-teal-primary" />
          <span className="ml-auto text-xs text-gray-500">{commFiltered.length} commercial contacts</span>
        </div>
        <div className="flex-1 overflow-auto border border-gray-200 rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">Name</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">Title</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">Organization</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">Org Type</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">Covered Lives</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">SME Owner</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">Deal Stage</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {commFiltered.map((c, i) => {
                const name = c.display_name || c.name || `${c.firstname || ""} ${c.lastname || ""}`.trim();
                const conf = c.data_confidence || "";
                return (
                  <tr key={i} className="border-t border-gray-100 hover:bg-teal-light/40">
                    <td className="px-3 py-1.5 font-medium text-gray-900">{name}</td>
                    <td className="px-3 py-1.5 text-xs text-gray-600">{c.confirmed_title || c.job_title || c.jobtitle || ""}</td>
                    <td className="px-3 py-1.5 text-xs text-gray-600">{c.confirmed_organization || c.company || c.Company || ""}</td>
                    <td className="px-3 py-1.5 text-xs">{c.org_type || ""}</td>
                    <td className="px-3 py-1.5 text-xs">{c.covered_lives ? Number(c.covered_lives).toLocaleString() : ""}</td>
                    <td className="px-3 py-1.5 text-xs">{c["SME Owner"] || c.sme_owner || ""}</td>
                    <td className="px-3 py-1.5 text-xs">{c.deal_stage || c["Deal Stage"] || ""}</td>
                    <td className="px-3 py-1.5">
                      {conf && <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${confColor[conf] || "bg-gray-100 text-gray-600"}`}>{conf}</span>}
                    </td>
                  </tr>
                );
              })}
              {commFiltered.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-400 text-sm">
                  No commercial contacts found. Upload a CSV with "KOL Type" = "Commercial" in the CSV Import/Export tab.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ── Research table view (default) ──────────────────────────────────────
  return (
    <div className="h-full flex flex-col p-4 gap-3 overflow-hidden">
      {/* Re-engagement queue */}
      {reengageQueue.length > 0 && (
        <div className="bg-teal-light border border-teal-primary/20 rounded-lg px-4 py-2">
          <p className="text-xs font-semibold text-teal-primary mb-1">
            Re-engagement Queue ({reengageQueue.length} Tier A/B KOLs)
          </p>
          <div className="flex flex-wrap gap-2">
            {reengageQueue.slice(0, 8).map((k) => (
              <button
                key={k.openalex_id}
                onClick={() => onSelectKOL(k)}
                className="text-xs bg-white border border-teal-primary/30 rounded px-2 py-0.5 hover:bg-teal-primary hover:text-white transition-colors"
              >
                {k.display_name} ({k.tier})
              </button>
            ))}
            {reengageQueue.length > 8 && (
              <span className="text-xs text-gray-500">+{reengageQueue.length - 8} more</span>
            )}
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="Search name or institution..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm w-64 focus:outline-none focus:border-teal-primary"
        />
        <select
          value={tierFilter}
          onChange={(e) => setTierFilter(e.target.value)}
          className="border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-teal-primary"
        >
          <option value="">All Tiers</option>
          <option value="A">Tier A</option>
          <option value="B">Tier B</option>
          <option value="C">Tier C</option>
          <option value="D">Tier D</option>
        </select>
        {selected.size > 0 && (
          <button
            onClick={exportSelected}
            className="bg-teal-primary text-white text-sm px-3 py-1.5 rounded hover:bg-teal-dark transition-colors"
          >
            Export {selected.size} as CSV
          </button>
        )}
        <span className="ml-auto text-xs text-gray-500">
          {filtered.length} of {nodes.length} KOLs
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto border border-gray-200 rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <th className="px-3 py-2 w-8">
                <input
                  type="checkbox"
                  checked={selected.size === filtered.length && filtered.length > 0}
                  onChange={toggleAll}
                />
              </th>
              <SortHeader label="Name" field="display_name" className="min-w-[180px]" />
              <SortHeader label="Institution" field="institution" className="min-w-[160px]" />
              <SortHeader label="Tier" field="tier" className="w-16" />
              <SortHeader label="OPS" field="ops_score" className="w-16" />
              <SortHeader label="Sci" field="scientific_influence_score" className="w-12" />
              <SortHeader label="Alg" field="clinical_alignment_score" className="w-12" />
              <SortHeader label="Rch" field="reach_visibility_score" className="w-12" />
              <SortHeader label="Nut" field="nutrition_openness_score" className="w-12" />
              <SortHeader label="Str" field="strategic_value_score" className="w-12" />
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600 w-20">Stance</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const prof = profileMap[r.openalex_id];
              const stance = prof?.nutrition_stance_assessment;
              const level = typeof stance === "object" ? stance?.level : stance;

              return (
                <tr
                  key={r.openalex_id}
                  className="border-t border-gray-100 hover:bg-teal-light/40 transition-colors"
                >
                  <td className="px-3 py-1.5">
                    <input
                      type="checkbox"
                      checked={selected.has(r.openalex_id)}
                      onChange={() => toggleSelect(r.openalex_id)}
                    />
                  </td>
                  <td
                    className="px-3 py-1.5 font-medium text-teal-primary cursor-pointer hover:underline"
                    onClick={() => onSelectKOL(r)}
                  >
                    {r.display_name}
                  </td>
                  <td className="px-3 py-1.5 text-gray-600 text-xs">{r.institution || "—"}</td>
                  <td className="px-3 py-1.5">
                    <span
                      className="inline-block w-6 h-6 rounded-full text-white text-xs font-bold text-center leading-6"
                      style={{ backgroundColor: TIER_COLORS[r.tier] }}
                    >
                      {r.tier}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 font-semibold">{r.ops_score?.toFixed(1)}</td>
                  <td className="px-3 py-1.5 text-xs">{r.scientific_influence_score?.toFixed(1)}</td>
                  <td className="px-3 py-1.5 text-xs">{r.clinical_alignment_score?.toFixed(1)}</td>
                  <td className="px-3 py-1.5 text-xs">{r.reach_visibility_score?.toFixed(1)}</td>
                  <td className="px-3 py-1.5 text-xs">{r.nutrition_openness_score?.toFixed(1)}</td>
                  <td className="px-3 py-1.5 text-xs">{r.strategic_value_score?.toFixed(1)}</td>
                  <td className="px-3 py-1.5">
                    {level && (
                      <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${
                        level === "HIGH" ? "bg-green-100 text-green-800" :
                        level === "MEDIUM" ? "bg-yellow-100 text-yellow-800" :
                        level === "LOW" ? "bg-red-100 text-red-800" : "bg-gray-100 text-gray-600"
                      }`}>{level}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
