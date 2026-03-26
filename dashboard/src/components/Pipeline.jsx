import { useState, useMemo, useCallback } from "react";
import Papa from "papaparse";

// ── Therapeutic area detection ──────────────────────────────────────────

const AREA_KEYWORDS = {
  T2D: ["diabetes", "t2d", "hba1c", "glycated hemoglobin", "blood glucose", "insulin"],
  Obesity: ["obesity", "weight loss", "bmi", "bariatric"],
  "MASLD-MASH": ["masld", "mash", "nafld", "nash", "fatty liver", "steatotic", "steatohepatitis"],
  "Metabolic Psychiatry": ["psychiatry", "mental", "depression", "cognitive", "brain health"],
  HEOR: ["economics", "cost", "qaly", "claims", "budget impact", "value-based", "payer"],
  Cardiovascular: ["cardiovascular", "cardiac", "heart", "hypertension", "lipid", "dyslipidemia"],
  "Pancreatic Cancer": ["pancreatic", "pancreas"],
};

function detectAreas(contact) {
  const text = [
    contact.institution, contact.company, contact.Company,
    contact.clinical_relevance_score, contact.collaboration_reason,
    contact.top_paper_title, contact.nutrition_signal_keywords,
  ].filter(Boolean).join(" ").toLowerCase();

  return Object.entries(AREA_KEYWORDS)
    .filter(([, kws]) => kws.some((k) => text.includes(k)))
    .map(([area]) => area);
}

// ── Pipeline stage classification ──────────────────────────────────────

function classifyStage(c) {
  const coauthor = ["true", "yes", "1"].includes(
    (c["Virta Paper CoAuthor"] || c.virta_paper_coauthor || "").toLowerCase()
  );
  const stance = (c.nutrition_stance || "").toLowerCase();
  if (coauthor || stance.includes("keto-aligned")) return "CONTRACTED";

  const tier = c.kol_tier || c["MA_OPS Tier"] || c.ma_ops_tier || "";
  const isAB = ["A", "B"].includes(tier);
  if (!isAB) return null; // Only A/B in pipeline

  const lastContact = c["Last Activity Date"] || c.last_contacted || c.last_contact_date || "";
  const response = c.response || c.response_recorded || "";

  if (lastContact && response) return "ENGAGED";
  if (lastContact && !response) return "ACTIVE OUTREACH";
  return "PROSPECTS";
}

// ── Component ──────────────────────────────────────────────────────────

const STAGES = ["CONTRACTED", "ENGAGED", "ACTIVE OUTREACH", "PROSPECTS"];
const STAGE_COLORS = {
  CONTRACTED: { bg: "bg-green-50", border: "border-green-300", header: "bg-green-600" },
  ENGAGED: { bg: "bg-blue-50", border: "border-blue-300", header: "bg-blue-600" },
  "ACTIVE OUTREACH": { bg: "bg-yellow-50", border: "border-yellow-300", header: "bg-yellow-600" },
  PROSPECTS: { bg: "bg-gray-50", border: "border-gray-300", header: "bg-gray-500" },
};

const TIER_BADGE = {
  A: "bg-green-100 text-green-800",
  B: "bg-blue-100 text-blue-800",
  C: "bg-yellow-100 text-yellow-800",
  D: "bg-gray-100 text-gray-800",
};

export default function Pipeline({ contacts: externalContacts, uploadDate: externalDate, onContactsLoaded }) {
  const [view, setView] = useState("kanban");
  const [localContacts, setLocalContacts] = useState(null);
  const [localDate, setLocalDate] = useState(null);

  const contacts = externalContacts || localContacts;
  const uploadDate = externalDate || localDate;

  function handleDirectUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        setLocalContacts(result.data);
        setLocalDate(new Date().toLocaleDateString());
        if (onContactsLoaded) onContactsLoaded(result.data);
      },
    });
  }

  // Classify contacts into stages
  const { staged, stats } = useMemo(() => {
    if (!contacts?.length) return { staged: {}, stats: {} };

    const staged = { CONTRACTED: [], ENGAGED: [], "ACTIVE OUTREACH": [], PROSPECTS: [] };
    let tierA = 0, tierB = 0, contracted = 0, outreach = 0, totalOps = 0, opsCount = 0;

    for (const c of contacts) {
      const tier = c.kol_tier || c["MA_OPS Tier"] || c.ma_ops_tier || "";
      if (tier === "A") tierA++;
      if (tier === "B") tierB++;
      const ops = parseFloat(c.ops_score);
      if (!isNaN(ops)) { totalOps += ops; opsCount++; }

      const stage = classifyStage(c);
      if (stage === "CONTRACTED") contracted++;
      if (stage === "ACTIVE OUTREACH") outreach++;
      if (stage && staged[stage]) {
        staged[stage].push({ ...c, _tier: tier, _stage: stage, _areas: detectAreas(c) });
      }
    }

    return {
      staged,
      stats: {
        total: contacts.length,
        tierA, tierB, contracted, outreach,
        avgOps: opsCount ? Math.round(totalOps / opsCount * 10) / 10 : 0,
        pipelineTotal: Object.values(staged).reduce((s, arr) => s + arr.length, 0),
      },
    };
  }, [contacts]);

  // Coverage map data
  const coverage = useMemo(() => {
    if (!contacts?.length) return [];
    const areas = Object.keys(AREA_KEYWORDS);
    return areas.map((area) => {
      const inArea = (contacts || []).filter((c) => {
        const text = [c.institution, c.company, c.Company, c.top_paper_title,
          c.collaboration_reason, c.nutrition_signal_keywords].filter(Boolean).join(" ").toLowerCase();
        return AREA_KEYWORDS[area].some((k) => text.includes(k));
      });
      const tierAContracted = inArea.filter((c) => {
        const tier = c.kol_tier || c["MA_OPS Tier"] || "";
        return tier === "A" && classifyStage(c) === "CONTRACTED";
      }).length;
      const tierAActive = inArea.filter((c) => {
        const tier = c.kol_tier || c["MA_OPS Tier"] || "";
        return tier === "A" && ["ENGAGED", "ACTIVE OUTREACH"].includes(classifyStage(c));
      }).length;
      const tierBPipeline = inArea.filter((c) => {
        const tier = c.kol_tier || c["MA_OPS Tier"] || "";
        return tier === "B";
      }).length;
      return { area, tierAContracted, tierAActive, tierBPipeline, total: inArea.length };
    });
  }, [contacts]);

  const handleFileUpload = useCallback((e) => {
    // This is handled by App.jsx via onUpload prop — placeholder
  }, []);

  function exportHTML() {
    const rows = Object.entries(staged).flatMap(([stage, cards]) =>
      cards.map((c) => `<tr><td>${stage}</td><td>${c.firstname || ""} ${c.lastname || c.display_name || ""}</td><td>${c.institution || c.company || ""}</td><td>${c._tier}</td><td>${c.ops_score || ""}</td></tr>`)
    );
    const html = `<html><head><style>table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:8px;text-align:left}th{background:#00726B;color:white}</style></head><body><h2>KOL Pipeline Summary</h2><p>Generated ${new Date().toLocaleDateString()}</p><table><tr><th>Stage</th><th>Name</th><th>Institution</th><th>Tier</th><th>OPS</th></tr>${rows.join("")}</table></body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "pipeline_summary.html"; a.click();
    URL.revokeObjectURL(url);
  }

  if (!contacts?.length) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="text-center max-w-md">
          <p className="text-gray-500 text-sm mb-3">
            No contacts loaded. Upload a HubSpot CSV here or use the
            CSV Import/Export tab to enrich first.
          </p>
          <label className="bg-teal-primary text-white text-sm px-4 py-2 rounded cursor-pointer hover:bg-teal-dark transition-colors">
            Upload HubSpot CSV
            <input type="file" accept=".csv" onChange={handleDirectUpload} className="hidden" />
          </label>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* Stats bar */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-6 text-xs shrink-0">
        <div><span className="text-gray-500">Total KOLs:</span> <span className="font-bold text-gray-900">{stats.total}</span></div>
        <div><span className="text-gray-500">Tier A:</span> <span className="font-bold text-green-700">{stats.tierA}</span></div>
        <div><span className="text-gray-500">Tier B:</span> <span className="font-bold text-blue-700">{stats.tierB}</span></div>
        <div><span className="text-gray-500">Contracted:</span> <span className="font-bold text-teal-primary">{stats.contracted}</span></div>
        <div><span className="text-gray-500">Active Outreach:</span> <span className="font-bold text-yellow-700">{stats.outreach}</span></div>
        <div><span className="text-gray-500">Avg OPS:</span> <span className="font-bold text-gray-900">{stats.avgOps}</span></div>
        <div className="ml-auto flex items-center gap-3">
          {uploadDate && <span className="text-gray-400">Updated: {uploadDate}</span>}
          <div className="flex gap-1">
            <button onClick={() => setView("kanban")}
              className={`px-2 py-1 rounded text-xs ${view === "kanban" ? "bg-teal-primary text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
              Kanban
            </button>
            <button onClick={() => setView("coverage")}
              className={`px-2 py-1 rounded text-xs ${view === "coverage" ? "bg-teal-primary text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
              Coverage
            </button>
          </div>
          <button onClick={exportHTML} className="text-teal-primary hover:text-teal-dark text-xs font-medium">Export</button>
        </div>
      </div>

      {view === "kanban" ? (
        <div className="flex gap-4 p-4 h-[calc(100%-48px)] overflow-x-auto">
          {STAGES.map((stage) => {
            const sc = STAGE_COLORS[stage];
            const cards = staged[stage] || [];
            return (
              <div key={stage} className={`flex-1 min-w-[240px] max-w-[320px] flex flex-col rounded-lg border ${sc.border} ${sc.bg}`}>
                <div className={`${sc.header} text-white text-xs font-bold px-3 py-2 rounded-t-lg flex justify-between`}>
                  <span>{stage}</span>
                  <span>{cards.length}</span>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {cards.map((c, i) => {
                    const name = c.display_name || `${c.firstname || ""} ${c.lastname || ""}`.trim();
                    const inst = c.institution || c.company || c.Company || "";
                    return (
                      <div key={i} className="bg-white rounded border border-gray-200 p-3 shadow-sm">
                        <div className="flex items-start justify-between gap-1">
                          <p className="text-xs font-medium text-gray-900 leading-tight">{name}</p>
                          <span className={`text-[9px] font-bold px-1 py-0.5 rounded shrink-0 ${TIER_BADGE[c._tier] || TIER_BADGE.D}`}>
                            {c._tier || "?"}
                          </span>
                        </div>
                        <p className="text-[10px] text-gray-500 mt-0.5 truncate">{inst}</p>
                        <div className="flex items-center gap-2 mt-1.5">
                          {c.ops_score && <span className="text-[10px] text-gray-600">OPS {c.ops_score}</span>}
                          {c.nutrition_stance && <span className="text-[10px] text-gray-400 truncate">{c.nutrition_stance}</span>}
                        </div>
                      </div>
                    );
                  })}
                  {cards.length === 0 && (
                    <p className="text-[10px] text-gray-400 text-center py-4">No contacts</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="p-6 max-w-4xl mx-auto">
          <h3 className="text-sm font-bold text-gray-900 mb-3">Therapeutic Area Coverage</h3>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-teal-primary text-white">
                <th className="px-3 py-2 text-left">Area</th>
                <th className="px-3 py-2 text-center">Tier A Contracted</th>
                <th className="px-3 py-2 text-center">Tier A Active</th>
                <th className="px-3 py-2 text-center">Tier B Pipeline</th>
                <th className="px-3 py-2 text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {coverage.map((row) => {
                let status, statusColor;
                if (row.tierAContracted >= 1) {
                  status = "Covered"; statusColor = "bg-green-100 text-green-800";
                } else if (row.tierAActive >= 1 || row.tierBPipeline >= 2) {
                  status = "Thin"; statusColor = "bg-yellow-100 text-yellow-800";
                } else {
                  status = "Gap"; statusColor = "bg-red-100 text-red-800";
                }
                return (
                  <tr key={row.area} className="border-b border-gray-200 hover:bg-gray-50">
                    <td className="px-3 py-2 font-medium text-gray-900">{row.area}</td>
                    <td className="px-3 py-2 text-center">{row.tierAContracted}</td>
                    <td className="px-3 py-2 text-center">{row.tierAActive}</td>
                    <td className="px-3 py-2 text-center">{row.tierBPipeline}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${statusColor}`}>{status}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
