import { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import Papa from "papaparse";

// ── Constants ─────────────────────────────────────────────────────────

const TIER_STYLES = {
  A: "bg-blue-100 text-blue-800",
  B: "bg-emerald-100 text-emerald-800",
  C: "bg-gray-100 text-gray-700",
  D: "bg-gray-100 text-gray-400",
};

const CONN_LABELS = {
  colleague: "Colleague",
  former_colleague: "Former colleague",
  board: "Board member",
  advisory: "Advisory",
  "2nd_degree": "2nd degree",
  "3rd_degree": "3rd degree",
};

const FOCUS_LABELS = {
  metabolic: "Metabolic / Diabetes",
  vbc: "Value-Based Care",
  formulary: "Formulary / Pharmacy",
  population_health: "Population Health",
  general: "General",
};

const NODE_COLORS = {
  SEED: "#f59e0b",
  A: "#3b82f6",
  B: "#10b981",
  C: "#9ca3af",
  D: "#d1d5db",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CSV column detection ──────────────────────────────────────────────

function detectColumn(headers, candidates) {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const c of candidates) {
    const idx = lower.findIndex((h) => h.includes(c));
    if (idx !== -1) return headers[idx];
  }
  return null;
}

function normalizeRow(row, colMap) {
  const get = (key) => (colMap[key] ? (row[colMap[key]] || "").trim() : "");
  const firstName = get("first_name");
  const lastName = get("last_name");
  const fullName = get("name") || (firstName && lastName ? `${firstName} ${lastName}` : firstName || lastName || "");
  return {
    name: fullName,
    email: get("email"),
    title: get("title"),
    organization: get("organization"),
  };
}

function parseCSV(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: ({ data, meta }) => {
        if (!data.length) { reject(new Error("CSV is empty")); return; }
        const headers = meta.fields || [];
        const colMap = {
          name: detectColumn(headers, ["full name", "name", "contact name"]),
          first_name: detectColumn(headers, ["first name", "firstname", "first"]),
          last_name: detectColumn(headers, ["last name", "lastname", "last"]),
          email: detectColumn(headers, ["email", "e-mail", "email address"]),
          title: detectColumn(headers, ["job title", "title", "position", "role"]),
          organization: detectColumn(headers, ["company", "organization", "employer", "institution", "account"]),
        };
        const contacts = data
          .map((row) => normalizeRow(row, colMap))
          .filter((c) => c.name || c.email);
        if (!contacts.length) { reject(new Error("No usable contacts found — check column headers")); return; }
        resolve(contacts);
      },
      error: (err) => reject(new Error(err.message)),
    });
  });
}

// ── Name dedup ────────────────────────────────────────────────────────

function nameKey(name) {
  return (name || "").toLowerCase().replace(/[^a-z]/g, "");
}

// ── Utility ───────────────────────────────────────────────────────────

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

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ── D3 Graph ──────────────────────────────────────────────────────────

function NetworkMap({ seeds, prospects, edges, onSelectNode }) {
  const svgRef = useRef(null);

  useEffect(() => {
    if (!svgRef.current || (!seeds.length && !prospects.length)) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const { width, height } = svgRef.current.getBoundingClientRect();
    if (!width || !height) return;

    const allNodes = [
      ...seeds.map((s) => ({ ...s, _type: "seed" })),
      ...prospects.map((p) => ({ ...p, _type: "prospect" })),
    ];

    const nodeById = new Map(allNodes.map((n) => [n.id, n]));

    const links = edges
      .filter((e) => nodeById.has(e.source) && nodeById.has(e.target))
      .map((e) => ({ ...e, source: e.source, target: e.target }));

    const simulation = d3
      .forceSimulation(allNodes)
      .force("link", d3.forceLink(links).id((d) => d.id).distance(90).strength(0.6))
      .force("charge", d3.forceManyBody().strength(-220))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius((d) => (d._type === "seed" ? 18 : 12)));

    const g = svg.append("g");

    svg.call(
      d3.zoom()
        .scaleExtent([0.2, 3])
        .on("zoom", (e) => g.attr("transform", e.transform))
    );

    // Links
    const link = g
      .append("g")
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("stroke", "#e5e7eb")
      .attr("stroke-width", (d) => Math.max(1, (d.strength || 0.3) * 4))
      .attr("stroke-opacity", 0.7);

    // Node groups
    const nodeG = g
      .append("g")
      .selectAll("g")
      .data(allNodes)
      .join("g")
      .style("cursor", "pointer")
      .on("click", (e, d) => { e.stopPropagation(); onSelectNode(d); })
      .call(
        d3.drag()
          .on("start", (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
          .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
          .on("end", (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
      );

    nodeG
      .append("circle")
      .attr("r", (d) => (d._type === "seed" ? 13 : 9))
      .attr("fill", (d) => {
        if (d._type === "seed") return NODE_COLORS.SEED;
        return NODE_COLORS[d.tier] || NODE_COLORS.C;
      })
      .attr("stroke", "#fff")
      .attr("stroke-width", 2);

    nodeG
      .append("text")
      .text((d) => {
        const name = d.confirmed_name || d.full_name || d.original_name || "";
        const parts = name.split(" ");
        return parts.length >= 2 ? `${parts[0][0]}. ${parts[parts.length - 1]}` : name;
      })
      .attr("x", (d) => (d._type === "seed" ? 16 : 12))
      .attr("y", 4)
      .attr("font-size", "10px")
      .attr("fill", "#374151")
      .attr("pointer-events", "none");

    // Click on background to deselect
    svg.on("click", () => onSelectNode(null));

    simulation.on("tick", () => {
      link
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);
      nodeG.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });

    return () => simulation.stop();
  }, [seeds, prospects, edges]);

  return (
    <svg
      ref={svgRef}
      className="w-full h-full"
      style={{ background: "#f9fafb" }}
    />
  );
}

// ── Sub-components ────────────────────────────────────────────────────

function FilterGroup({ label, value, setValue, options }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-gray-500 text-xs mr-1">{label}:</span>
      <div className="flex bg-gray-100 rounded p-0.5">
        {options.map((o) => (
          <button
            key={o.v}
            onClick={() => setValue(o.v)}
            className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
              value === o.v ? "bg-white text-teal-primary shadow-sm" : "text-gray-600 hover:text-gray-900"
            }`}
          >
            {o.l}
          </button>
        ))}
      </div>
    </div>
  );
}

function ConfidenceBadge({ level }) {
  const styles = {
    HIGH: "bg-green-100 text-green-700",
    MEDIUM: "bg-yellow-100 text-yellow-700",
    LOW: "bg-gray-100 text-gray-500",
  };
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${styles[level] || styles.LOW}`}>
      {level || "LOW"}
    </span>
  );
}

function DetailPanel({ contact, onClose }) {
  if (!contact) return null;
  const isSeed = contact.status === "SEED" || contact._type === "seed";
  const name = contact.confirmed_name || contact.full_name || contact.original_name || "—";
  const title = contact.confirmed_title || contact.title || contact.original_title || "—";
  const org = contact.confirmed_org || contact.organization || contact.original_org || "—";

  return (
    <div className="w-96 bg-white border-l border-gray-200 overflow-auto shrink-0 relative">
      <button
        onClick={onClose}
        className="absolute top-3 right-3 text-gray-400 hover:text-gray-700 text-xl leading-none"
      >
        ×
      </button>
      <div className="p-5">
        <div className="flex items-center gap-2 mb-1">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${isSeed ? "bg-amber-100 text-amber-800" : (TIER_STYLES[contact.tier] || TIER_STYLES.C)}`}>
            {isSeed ? "SEED" : `Tier ${contact.tier || "D"}`}
          </span>
          {!isSeed && <ConfidenceBadge level={contact.data_confidence} />}
        </div>
        <h2 className="text-lg font-bold text-gray-900 leading-tight mb-0.5">{name}</h2>
        <p className="text-sm text-gray-600 mb-0.5">{title}</p>
        <p className="text-xs text-gray-500 mb-4">{org}</p>

        {!isSeed && (
          <>
            <div className="bg-teal-light/40 border border-teal-primary/20 rounded p-3 mb-4">
              <div className="text-3xl font-bold text-teal-primary">
                {(contact.ips_score || 0).toFixed(0)}
                <span className="text-sm font-normal text-gray-500 ml-1">/ 100 IPS</span>
              </div>
            </div>

            {contact.score_breakdown && (
              <>
                <h3 className="text-xs font-bold uppercase text-gray-500 mb-2">Score Breakdown</h3>
                <div className="space-y-1.5 mb-4">
                  {[
                    ["Role Seniority", contact.score_breakdown.seniority],
                    ["Org Scale", contact.score_breakdown.org_scale],
                    ["Strategic Relevance", contact.score_breakdown.strategic_relevance],
                    ["Connection Strength", contact.score_breakdown.connection_strength],
                    ["Engagement Signal", contact.score_breakdown.engagement],
                  ].map(([label, val]) => (
                    <div key={label}>
                      <div className="flex items-baseline justify-between text-xs">
                        <span className="text-gray-700">{label}</span>
                        <span className="font-medium text-gray-900">{val} / 20</span>
                      </div>
                      <div className="h-1 bg-gray-100 rounded mt-0.5">
                        <div className="h-1 bg-teal-primary rounded" style={{ width: `${(val / 20) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            <hr className="my-4 border-gray-200" />
            <h3 className="text-xs font-bold uppercase text-gray-500 mb-2">Connection</h3>
            <div className="space-y-1 text-xs mb-4">
              <div className="flex justify-between gap-2">
                <span className="text-gray-500">Via</span>
                <span className="text-gray-900 font-medium text-right">{contact.seed_name || "—"}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-gray-500">Type</span>
                <span className="text-gray-900 font-medium text-right">{CONN_LABELS[contact.connection_type] || contact.connection_type || "—"}</span>
              </div>
              {contact.connection_detail && (
                <p className="text-gray-600 mt-1 leading-relaxed">{contact.connection_detail}</p>
              )}
            </div>
          </>
        )}

        <hr className="my-4 border-gray-200" />
        <h3 className="text-xs font-bold uppercase text-gray-500 mb-2">Details</h3>
        <div className="space-y-1 text-xs">
          {[
            ["Org Type", contact.org_type],
            ["Strategic Focus", FOCUS_LABELS[contact.strategic_focus] || contact.strategic_focus],
            ["Email", isSeed ? contact.original_email : ""],
          ].filter(([, v]) => v).map(([label, val]) => (
            <div key={label} className="flex justify-between gap-2">
              <span className="text-gray-500">{label}</span>
              <span className="text-gray-900 font-medium text-right">{val}</span>
            </div>
          ))}
          {contact.recent_news && (
            <p className="text-gray-600 mt-2 leading-relaxed border-t border-gray-100 pt-2">{contact.recent_news}</p>
          )}
          {contact.linkedin_url && (
            <a
              href={contact.linkedin_url}
              target="_blank"
              rel="noreferrer"
              className="block mt-2 text-teal-primary underline truncate"
            >
              LinkedIn →
            </a>
          )}
          {contact.source_url && (
            <a
              href={contact.source_url}
              target="_blank"
              rel="noreferrer"
              className="block mt-1 text-gray-400 underline truncate text-[10px]"
            >
              Source →
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────

export default function MSLIntelligence() {
  const [phase, setPhase] = useState("upload"); // upload | processing | results
  const [seeds, setSeeds] = useState([]);
  const [enrichedSeeds, setEnrichedSeeds] = useState([]);
  const [prospects, setProspects] = useState([]);
  const [edges, setEdges] = useState([]);
  const [progress, setProgress] = useState({ current: 0, total: 0, currentName: "" });
  const [errors, setErrors] = useState([]);
  const [activeView, setActiveView] = useState("table");
  const [filterTier, setFilterTier] = useState("all");
  const [filterConn, setFilterConn] = useState("all");
  const [filterFocus, setFilterFocus] = useState("all");
  const [searchText, setSearchText] = useState("");
  const [sortField, setSortField] = useState("ips_score");
  const [sortDir, setSortDir] = useState("desc");
  const [selectedContact, setSelectedContact] = useState(null);
  const [uploadError, setUploadError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  // ── CSV Upload ──────────────────────────────────────────────────────

  async function handleFile(file) {
    if (!file) return;
    setUploadError("");
    try {
      const contacts = await parseCSV(file);
      setSeeds(contacts);
    } catch (err) {
      setUploadError(err.message);
    }
  }

  // ── Enrichment loop ─────────────────────────────────────────────────

  async function startEnrichment() {
    const apiKey = localStorage.getItem("kol_gemini_key") || "";
    if (!apiKey) {
      setUploadError("Gemini API key not found. Add it in Settings first.");
      return;
    }

    setPhase("processing");
    setEnrichedSeeds([]);
    setProspects([]);
    setEdges([]);
    setErrors([]);
    setProgress({ current: 0, total: seeds.length, currentName: "" });

    const allEnrichedSeeds = [];
    const allProspects = [];
    const allEdges = [];
    const seenNames = new Set(); // dedup across seeds

    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i];
      const name = seed.name || "";
      setProgress({ current: i + 1, total: seeds.length, currentName: name });

      try {
        const resp = await fetch("/api/msl-enrich", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Gemini-Key": apiKey,
          },
          body: JSON.stringify({ contact: seed }),
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || `API error ${resp.status}`);
        }

        const data = await resp.json();
        allEnrichedSeeds.push(data.seed);

        for (const prospect of data.prospects || []) {
          const key = nameKey(prospect.full_name);
          if (!key || seenNames.has(key)) continue;
          seenNames.add(key);
          allProspects.push(prospect);
          allEdges.push({
            source: data.seed.id,
            target: prospect.id,
            connection_type: prospect.connection_type,
            strength: (prospect.score_breakdown?.connection_strength || 4) / 20,
          });
        }
      } catch (err) {
        setErrors((prev) => [...prev, `${name}: ${err.message}`]);
        allEnrichedSeeds.push({
          id: `seed_${nameKey(name)}`,
          original_name: name,
          original_email: seed.email || "",
          original_title: seed.title || "",
          original_org: seed.organization || "",
          status: "SEED",
          data_confidence: "LOW",
          error: err.message,
        });
      }

      setEnrichedSeeds([...allEnrichedSeeds]);
      setProspects([...allProspects]);
      setEdges([...allEdges]);

      if (i < seeds.length - 1) await sleep(800);
    }

    setPhase("results");
  }

  // ── Filtered + sorted prospects ─────────────────────────────────────

  const visible = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    let rows = prospects.filter((p) => {
      if (filterTier !== "all" && p.tier !== filterTier) return false;
      if (filterConn !== "all" && p.connection_type !== filterConn) return false;
      if (filterFocus !== "all" && p.strategic_focus !== filterFocus) return false;
      if (q) {
        const name = (p.full_name || "").toLowerCase();
        const org = (p.organization || "").toLowerCase();
        const seed = (p.seed_name || "").toLowerCase();
        if (!name.includes(q) && !org.includes(q) && !seed.includes(q)) return false;
      }
      return true;
    });

    rows = rows.slice().sort((a, b) => {
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
  }, [prospects, filterTier, filterConn, filterFocus, searchText, sortField, sortDir]);

  function toggleSort(field) {
    if (sortField === field) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("desc"); }
  }

  // ── Stats ───────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const tiers = { A: 0, B: 0, C: 0, D: 0 };
    for (const p of prospects) tiers[p.tier || "D"]++;
    return { ...tiers, total: prospects.length };
  }, [prospects]);

  // ── Export ──────────────────────────────────────────────────────────

  function exportHubSpotCSV() {
    const headers = [
      "First Name", "Last Name", "Email", "Company", "Job Title",
      "IPS Score", "Tier", "Status", "Connection Via", "Connection Type",
      "Strategic Focus", "Org Type", "Data Confidence", "Recent News",
      "LinkedIn URL", "Source URL",
    ];
    const rows = visible.map((p) => {
      const [first, last] = splitName(p.full_name);
      return {
        "First Name": first,
        "Last Name": last,
        "Email": "",
        "Company": p.organization || "",
        "Job Title": p.title || "",
        "IPS Score": (p.ips_score || 0).toFixed(0),
        "Tier": p.tier || "D",
        "Status": "NET-NEW",
        "Connection Via": p.seed_name || "",
        "Connection Type": CONN_LABELS[p.connection_type] || p.connection_type || "",
        "Strategic Focus": FOCUS_LABELS[p.strategic_focus] || p.strategic_focus || "",
        "Org Type": p.org_type || "",
        "Data Confidence": p.data_confidence || "",
        "Recent News": p.recent_news || "",
        "LinkedIn URL": p.linkedin_url || "",
        "Source URL": p.source_url || "",
      };
    });
    const lines = [headers.join(",")];
    for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(","));
    downloadBlob(lines.join("\n"), `msl_prospects_hubspot_${todayStamp()}.csv`, "text/csv");
  }

  // ── Phase: Upload ───────────────────────────────────────────────────

  if (phase === "upload") {
    return (
      <div className="h-full flex items-center justify-center p-6 bg-gray-50">
        <div className="w-full max-w-2xl space-y-4">
          <div
            className={`rounded-lg border-2 border-dashed p-12 text-center transition-colors ${
              isDragging ? "border-teal-primary bg-teal-light/40" : "border-gray-300 bg-white"
            }`}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFile(e.dataTransfer.files?.[0]); }}
          >
            <div className="text-5xl mb-3">🎥</div>
            <h2 className="text-lg font-semibold text-gray-800 mb-1">MSL Intelligence</h2>
            <p className="text-sm text-gray-600 mb-2">
              Upload your MSL HubSpot contact list to map their networks and surface net-new payer prospects
            </p>
            <p className="text-xs text-gray-400 mb-6">
              Expects columns: Name, Email, Job Title, Company / Organization
            </p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-4 py-2 bg-teal-primary text-white text-sm font-medium rounded hover:bg-teal-dark transition-colors"
            >
              Choose CSV file
            </button>
            <p className="text-xs text-gray-500 mt-2">or drag & drop a file here</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
            {uploadError && <p className="mt-4 text-sm text-red-600 font-medium">{uploadError}</p>}
          </div>

          {seeds.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-lg p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm font-semibold text-gray-800">
                    {seeds.length} contacts loaded
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Each contact will use one Gemini Search call. Estimated time: ~{Math.ceil(seeds.length * 1.5)} minutes.
                  </p>
                </div>
                <button
                  onClick={() => { setSeeds([]); setUploadError(""); }}
                  className="text-xs text-gray-400 hover:text-gray-600 underline"
                >
                  Clear
                </button>
              </div>

              <div className="max-h-40 overflow-auto border border-gray-100 rounded text-xs mb-4">
                <table className="w-full">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      {["Name", "Email", "Title", "Organization"].map((h) => (
                        <th key={h} className="px-3 py-1.5 text-left text-gray-500 font-semibold">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {seeds.slice(0, 8).map((s, i) => (
                      <tr key={i} className="border-t border-gray-100">
                        <td className="px-3 py-1.5 text-gray-900 font-medium">{s.name || "—"}</td>
                        <td className="px-3 py-1.5 text-gray-500">{s.email || "—"}</td>
                        <td className="px-3 py-1.5 text-gray-700">{s.title || "—"}</td>
                        <td className="px-3 py-1.5 text-gray-700">{s.organization || "—"}</td>
                      </tr>
                    ))}
                    {seeds.length > 8 && (
                      <tr className="border-t border-gray-100">
                        <td colSpan={4} className="px-3 py-1.5 text-gray-400 text-center">
                          +{seeds.length - 8} more
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <button
                onClick={startEnrichment}
                className="w-full py-2.5 bg-teal-primary text-white text-sm font-semibold rounded hover:bg-teal-dark transition-colors"
              >
                Run Network Expansion →
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Phase: Processing ───────────────────────────────────────────────

  if (phase === "processing") {
    const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
    return (
      <div className="h-full flex items-center justify-center p-6 bg-gray-50">
        <div className="w-full max-w-lg bg-white rounded-lg border border-gray-200 p-8">
          <h2 className="text-base font-semibold text-gray-800 mb-1">Expanding Network</h2>
          <p className="text-sm text-gray-500 mb-6">
            Enriching contact {progress.current} of {progress.total}
            {progress.currentName ? ` — ${progress.currentName}` : ""}
          </p>

          <div className="h-2 bg-gray-100 rounded-full mb-2">
            <div
              className="h-2 bg-teal-primary rounded-full transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-gray-400 text-right mb-6">{pct}%</p>

          {prospects.length > 0 && (
            <div className="flex gap-3 text-xs">
              <span className="px-2 py-1 rounded bg-amber-100 text-amber-800 font-semibold">
                {enrichedSeeds.length} seeds processed
              </span>
              <span className="px-2 py-1 rounded bg-blue-100 text-blue-800 font-semibold">
                {prospects.filter((p) => p.tier === "A").length} Tier A found
              </span>
              <span className="px-2 py-1 rounded bg-gray-100 text-gray-700 font-semibold">
                {prospects.length} total prospects
              </span>
            </div>
          )}

          {errors.length > 0 && (
            <div className="mt-4 p-3 bg-red-50 rounded text-xs text-red-700 max-h-24 overflow-auto">
              {errors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Phase: Results ──────────────────────────────────────────────────

  const SortHeader = ({ label, field, align = "left" }) => {
    const active = sortField === field;
    return (
      <th
        onClick={() => toggleSort(field)}
        className={`px-3 py-2 text-${align} text-xs font-semibold text-gray-600 cursor-pointer hover:text-teal-primary select-none`}
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
          <span className="text-xs px-2 py-1 rounded bg-amber-100 text-amber-800 font-semibold">
            {enrichedSeeds.length} Seeds
          </span>
          <span className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-800 font-semibold">
            {stats.A} Tier A
          </span>
          <span className="text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-800 font-semibold">
            {stats.B} Tier B
          </span>
          <span className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-700 font-semibold">
            {stats.C + stats.D} Tier C/D
          </span>
          <span className="text-xs text-gray-500 ml-1">{stats.total} net-new prospects</span>

          {/* View toggle */}
          <div className="ml-auto flex bg-gray-200 rounded p-0.5 gap-0.5">
            {[["table", "Table"], ["graph", "Graph"]].map(([v, l]) => (
              <button
                key={v}
                onClick={() => setActiveView(v)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  activeView === v ? "bg-white text-gray-800 shadow-sm" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {l}
              </button>
            ))}
          </div>

          <button
            onClick={() => { setPhase("upload"); setSeeds([]); setEnrichedSeeds([]); setProspects([]); setEdges([]); }}
            className="text-xs text-gray-400 hover:text-teal-primary underline"
          >
            New upload
          </button>
        </div>

        {/* Filter bar — table only */}
        {activeView === "table" && (
          <div className="flex items-center gap-3 flex-wrap text-xs">
            <FilterGroup label="Tier" value={filterTier} setValue={setFilterTier} options={[
              { v: "all", l: "All" }, { v: "A", l: "A" }, { v: "B", l: "B" }, { v: "C", l: "C" },
            ]} />
            <FilterGroup label="Connection" value={filterConn} setValue={setFilterConn} options={[
              { v: "all", l: "All" }, { v: "colleague", l: "Colleague" }, { v: "former_colleague", l: "Former" },
              { v: "board", l: "Board" }, { v: "advisory", l: "Advisory" },
            ]} />
            <FilterGroup label="Focus" value={filterFocus} setValue={setFilterFocus} options={[
              { v: "all", l: "All" }, { v: "metabolic", l: "Metabolic" }, { v: "vbc", l: "VBC" },
              { v: "formulary", l: "Formulary" }, { v: "population_health", l: "Pop Health" },
            ]} />
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search name, org, or seed…"
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-64 focus:outline-none focus:border-teal-primary"
            />
            <span className="ml-auto text-xs text-gray-500">
              {visible.length} match{visible.length === 1 ? "" : "es"}
            </span>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {activeView === "graph" ? (
            <div className="h-full rounded-lg border border-gray-200 overflow-hidden relative">
              <NetworkMap
                seeds={enrichedSeeds}
                prospects={prospects}
                edges={edges}
                onSelectNode={setSelectedContact}
              />
              {/* Legend */}
              <div className="absolute bottom-4 left-4 bg-white/90 border border-gray-200 rounded p-3 text-xs space-y-1.5">
                {[
                  [NODE_COLORS.SEED, "Seed (existing MSL contact)"],
                  [NODE_COLORS.A, "Tier A prospect (IPS ≥ 75)"],
                  [NODE_COLORS.B, "Tier B prospect (IPS ≥ 55)"],
                  [NODE_COLORS.C, "Tier C/D prospect"],
                ].map(([color, label]) => (
                  <div key={label} className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
                    <span className="text-gray-600">{label}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-auto border border-gray-200 rounded-lg bg-white h-full">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <SortHeader label="Tier" field="tier" />
                    <SortHeader label="Name / Organization" field="full_name" />
                    <SortHeader label="IPS" field="ips_score" align="right" />
                    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">Title</th>
                    <SortHeader label="Connection Via" field="seed_name" />
                    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">Type</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">Focus</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((p, i) => (
                    <tr
                      key={p.id || i}
                      onClick={() => setSelectedContact(p)}
                      className="border-t border-gray-100 hover:bg-teal-light/40 cursor-pointer"
                    >
                      <td className="px-3 py-1.5">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${TIER_STYLES[p.tier] || TIER_STYLES.D}`}>
                          {p.tier || "D"}
                        </span>
                      </td>
                      <td className="px-3 py-1.5">
                        <div className="font-medium text-gray-900">{p.full_name || "—"}</div>
                        <div className="text-xs text-gray-500">{p.organization || "—"}</div>
                      </td>
                      <td className="px-3 py-1.5 text-right font-semibold text-gray-900">
                        {(p.ips_score || 0).toFixed(0)}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-gray-600" title={p.title}>
                        {truncate(p.title || "—", 40)}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-gray-600">
                        {p.seed_name || "—"}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-gray-500">
                        {CONN_LABELS[p.connection_type] || p.connection_type || "—"}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-gray-500">
                        {FOCUS_LABELS[p.strategic_focus] || p.strategic_focus || "—"}
                      </td>
                      <td className="px-3 py-1.5">
                        <ConfidenceBadge level={p.data_confidence} />
                      </td>
                    </tr>
                  ))}
                  {visible.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-3 py-8 text-center text-gray-400 text-sm">
                        No prospects match your filters
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Export */}
        <div className="flex gap-2">
          <button
            onClick={exportHubSpotCSV}
            className="px-3 py-1.5 text-sm bg-teal-primary text-white rounded hover:bg-teal-dark transition-colors"
          >
            Export HubSpot CSV ({visible.length})
          </button>
          {errors.length > 0 && (
            <span className="text-xs text-amber-600 self-center">
              {errors.length} contact{errors.length > 1 ? "s" : ""} had errors
            </span>
          )}
        </div>
      </div>

      {/* Detail panel */}
      {selectedContact && (
        <DetailPanel
          contact={selectedContact}
          onClose={() => setSelectedContact(null)}
        />
      )}
    </div>
  );
}
