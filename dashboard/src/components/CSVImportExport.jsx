import { useState, useCallback } from "react";
import Papa from "papaparse";

function getApiHeaders() {
  const headers = {};
  const geminiKey = localStorage.getItem("kol_gemini_key");
  const openalexEmail = localStorage.getItem("kol_openalex_email");
  if (geminiKey) headers["X-Gemini-Key"] = geminiKey;
  if (openalexEmail) headers["X-OpenAlex-Email"] = openalexEmail;
  return headers;
}

const HUBSPOT_COLUMNS = [
  "hs_object_id", "ops_score", "kol_tier", "scientific_influence_score",
  "clinical_alignment_score", "pharma_entanglement_score", "openalex_id",
  "orcid", "top_paper_title", "top_paper_doi", "h_index", "citation_count",
  "institution", "nutrition_signal_keywords", "last_profiled_date",
  "nutrition_stance", "nutrition_stance_source",
];

const PROFILE_COLUMNS = [
  "outreach_angle", "sme_briefing", "nutrition_stance_level",
  "nutrition_stance_reasoning", "red_flags", "tier_rationale",
];

const ALL_COLUMNS = [...HUBSPOT_COLUMNS, ...PROFILE_COLUMNS];

function downloadCSV(rows, filename, columns = HUBSPOT_COLUMNS) {
  const csv = Papa.unparse(rows, { columns });
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function CSVImportExport({ nodes, onContactsLoaded, kolMode = "All" }) {
  const [dragOver, setDragOver] = useState(false);
  const [enrichResult, setEnrichResult] = useState(null);
  const [enrichedRows, setEnrichedRows] = useState(null);
  const [enriching, setEnriching] = useState(false);
  const [commercialResult, setCommercialResult] = useState(null);
  const [error, setError] = useState(null);

  // Profile generation state
  const [profiling, setProfiling] = useState(false);
  const [profileProgress, setProfileProgress] = useState(null);
  const [profiles, setProfiles] = useState(null);
  const [profileError, setProfileError] = useState(null);

  const handleFile = useCallback(async (file) => {
    setEnriching(true);
    setEnrichResult(null);
    setEnrichedRows(null);
    setProfiles(null);
    setProfileError(null);
    setCommercialResult(null);
    setError(null);

    try {
      // First, parse CSV locally to detect KOL Type column
      const rawText = await file.text();
      const rawParsed = Papa.parse(rawText, { header: true, skipEmptyLines: true });
      const allRows = rawParsed.data;

      // Split by KOL Type
      const commercialRows = allRows.filter((r) =>
        (r["KOL Type"] || r.kol_type || "").toLowerCase() === "commercial"
      );
      const researchRows = allRows.filter((r) => {
        const kt = (r["KOL Type"] || r.kol_type || "").toLowerCase();
        return kt !== "commercial";
      });

      // Enrich research contacts via /api/enrich
      let enrichedResearchRows = [];
      let researchStats = { matched: 0, notFound: 0, total: researchRows.length };

      if (researchRows.length > 0) {
        // Rebuild CSV with only research rows
        const researchCsv = Papa.unparse(researchRows);
        const researchBlob = new Blob([researchCsv], { type: "text/csv" });
        const formData = new FormData();
        formData.append("file", new File([researchBlob], "research.csv", { type: "text/csv" }));

        const resp = await fetch("/api/enrich", {
          method: "POST",
          headers: getApiHeaders(),
          body: formData,
        });

        if (resp.ok) {
          researchStats.matched = parseInt(resp.headers.get("X-Enrichment-Matched") || "0", 10);
          researchStats.notFound = parseInt(resp.headers.get("X-Enrichment-NotFound") || "0", 10);
          const csvText = await (await resp.blob()).text();
          enrichedResearchRows = Papa.parse(csvText, { header: true, skipEmptyLines: true }).data;
        }
      }

      // Enrich commercial contacts via /api/commercial-enrich
      let enrichedCommercialRows = [];
      if (commercialRows.length > 0) {
        const commPayload = commercialRows.map((r) => ({
          hs_object_id: r.hs_object_id || r["Record ID"] || "",
          display_name: r.display_name || r.Name || r.name || `${r.firstname || ""} ${r.lastname || ""}`.trim(),
          company: r.company || r.Company || r.institution || r.Institution || "",
          job_title: r.job_title || r.jobtitle || r["Job Title"] || "",
          kol_type: "Commercial",
        }));

        try {
          const commResp = await fetch("/api/commercial-enrich", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getApiHeaders() },
            body: JSON.stringify(commPayload),
          });
          if (commResp.ok) {
            enrichedCommercialRows = await commResp.json();
          }
        } catch {
          // Commercial enrichment failed — keep raw rows
        }

        setCommercialResult({
          total: commercialRows.length,
          enriched: enrichedCommercialRows.length,
        });
      }

      // Merge all rows for pipeline view
      const allEnrichedRows = [
        ...enrichedResearchRows.map((r) => ({ ...r, kol_type: "Research" })),
        ...enrichedCommercialRows.map((r) => ({ ...r, kol_type: "Commercial" })),
        ...commercialRows.filter((_, i) => i >= enrichedCommercialRows.length)
          .map((r) => ({ ...r, kol_type: "Commercial" })),
      ];

      // Create combined blob for download
      const combinedCsv = Papa.unparse(allEnrichedRows);
      const combinedBlob = new Blob([combinedCsv], { type: "text/csv;charset=utf-8;" });

      setEnrichResult({
        matched: researchStats.matched,
        notFound: researchStats.notFound,
        total: allRows.length,
        blob: combinedBlob,
        researchCount: researchRows.length,
        commercialCount: commercialRows.length,
      });
      setEnrichedRows(allEnrichedRows);
      if (onContactsLoaded) onContactsLoaded(allEnrichedRows);
    } catch (err) {
      console.error("Enrichment failed:", err);
      setError(err.message);
    } finally {
      setEnriching(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file && file.name.endsWith(".csv")) handleFile(file);
    },
    [handleFile]
  );

  const handleInputChange = useCallback(
    (e) => {
      const file = e.target.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  // ── Profile generation ───────────────────────────────────────────────

  async function generateProfiles() {
    if (!enrichedRows) return;

    // Filter to matched rows with openalex_id
    const matchedKols = enrichedRows.filter(
      (r) => r.openalex_match_status === "matched" && r.openalex_id
    );

    if (!matchedKols.length) {
      setProfileError("No matched KOLs to profile.");
      return;
    }

    setProfiling(true);
    setProfileError(null);
    setProfiles(null);

    const BATCH_SIZE = 10;
    const allProfiles = [];
    const totalBatches = Math.ceil(matchedKols.length / BATCH_SIZE);

    try {
      for (let b = 0; b < totalBatches; b++) {
        const batch = matchedKols.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
        setProfileProgress({
          current: b * BATCH_SIZE + 1,
          total: matchedKols.length,
          batch: b + 1,
          totalBatches,
        });

        // Build KOL objects for the API
        const kolPayload = batch.map((r) => ({
          display_name: r.display_name || `${r.firstname || ""} ${r.lastname || ""}`.trim(),
          openalex_id: r.openalex_id,
          institution: r.institution,
          h_index: Number(r.h_index) || 0,
          citation_count: Number(r.citation_count) || 0,
          ops_score: Number(r.ops_score) || 0,
          kol_tier: r.kol_tier,
          scientific_influence_score: Number(r.scientific_influence_score) || 0,
          clinical_alignment_score: Number(r.clinical_alignment_score) || 0,
          reach_visibility_score: Number(r.reach_visibility_score) || 0,
          nutrition_openness_score: Number(r.nutrition_openness_score) || 0,
          pharma_entanglement_score: Number(r.pharma_entanglement_score) || 0,
          strategic_value_score: Number(r.pharma_entanglement_score) || 10,
        }));

        const resp = await fetch("/api/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getApiHeaders() },
          body: JSON.stringify(kolPayload),
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: resp.statusText }));
          throw new Error(err.error || `Profile API error: ${resp.status}`);
        }

        const batchProfiles = await resp.json();
        allProfiles.push(...batchProfiles);
      }

      setProfiles(allProfiles);
      setProfileProgress(null);
    } catch (err) {
      console.error("Profile generation failed:", err);
      setProfileError(err.message);
    } finally {
      setProfiling(false);
    }
  }

  // ── Download with profiles merged ────────────────────────────────────

  function downloadWithProfiles() {
    if (!enrichedRows || !profiles) return;

    // Build lookup: openalex_id → profile
    const profileMap = {};
    for (const p of profiles) {
      if (p.openalex_id) profileMap[p.openalex_id] = p;
    }

    const merged = enrichedRows.map((row) => {
      const p = profileMap[row.openalex_id];
      const stance = p?.nutrition_stance_assessment || {};
      return {
        ...row,
        outreach_angle: p?.outreach_angle || "",
        sme_briefing: p?.sme_briefing || "",
        nutrition_stance_level: stance.level || "",
        nutrition_stance_reasoning: stance.reasoning || "",
        red_flags: (p?.red_flags || []).join("; "),
        tier_rationale: p?.tier_rationale || "",
        // Also fill in the HubSpot nutrition fields
        nutrition_stance: stance.level || row.nutrition_stance || "",
        nutrition_stance_source: stance.level ? "gemini_profile" : row.nutrition_stance_source || "",
      };
    });

    downloadCSV(merged, "kol_enriched_with_profiles.csv", ALL_COLUMNS);
  }

  // ── Export full pipeline ─────────────────────────────────────────────

  function exportFullPipeline() {
    const rows = nodes.map((n) => ({
      hs_object_id: "",
      ops_score: n.ops_score,
      kol_tier: n.tier,
      scientific_influence_score: n.scientific_influence_score,
      clinical_alignment_score: n.clinical_alignment_score,
      pharma_entanglement_score: n.strategic_value_score,
      openalex_id: n.openalex_id,
      orcid: "",
      top_paper_title: "",
      top_paper_doi: "",
      h_index: n.h_index,
      citation_count: n.citation_count,
      institution: n.institution || "",
      nutrition_signal_keywords: "",
      last_profiled_date: new Date().toISOString().split("T")[0],
      nutrition_stance: "",
      nutrition_stance_source: "",
    }));
    downloadCSV(rows, "kol_full_export.csv");
  }

  // ── Render ───────────────────────────────────────────────────────────

  const matchedCount = enrichedRows
    ? enrichedRows.filter((r) => r.openalex_match_status === "matched").length
    : 0;

  return (
    <div className="h-full p-6 flex flex-col gap-6 max-w-3xl mx-auto">
      <h2 className="text-lg font-bold text-gray-900">CSV Import / Export</h2>

      {/* Enrich section */}
      <section>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">
          Enrich HubSpot Contacts via OpenAlex
        </h3>
        <p className="text-xs text-gray-500 mb-3">
          Upload a HubSpot contact export CSV. Each contact is searched in
          OpenAlex, scored with OPS, and returned as an enriched CSV download.
          No data is stored — purely transactional.
        </p>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
            enriching
              ? "border-yellow-400 bg-yellow-50"
              : dragOver
              ? "border-teal-primary bg-teal-light"
              : "border-gray-300 bg-white hover:border-gray-400"
          }`}
        >
          {enriching ? (
            <div>
              <div className="inline-block w-6 h-6 border-2 border-teal-primary border-t-transparent rounded-full animate-spin mb-2" />
              <p className="text-sm text-gray-700 font-medium">
                Enriching via OpenAlex...
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Searching authors and computing OPS scores. This may take a
                minute for large files.
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm text-gray-600 mb-2">
                Drag & drop a HubSpot CSV here
              </p>
              <p className="text-xs text-gray-400 mb-3">or</p>
              <label className="bg-teal-primary text-white text-sm px-4 py-2 rounded cursor-pointer hover:bg-teal-dark transition-colors">
                Choose File
                <input
                  type="file"
                  accept=".csv"
                  onChange={handleInputChange}
                  className="hidden"
                />
              </label>
            </>
          )}
        </div>

        {error && (
          <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {enrichResult && (
          <div className="mt-3 bg-gray-50 rounded-lg p-4 space-y-3">
            <p className="text-sm font-semibold text-gray-800">
              {enrichResult.researchCount > 0 && `Research: ${enrichResult.matched} matched`}
              {enrichResult.commercialCount > 0 && ` | Commercial: ${enrichResult.commercialCount} enriched`}
              {!enrichResult.researchCount && !enrichResult.commercialCount && `Matched ${enrichResult.matched} of ${enrichResult.total} contacts`}
            </p>
            {enrichResult.notFound > 0 && (
              <p className="text-xs text-gray-500">
                {enrichResult.notFound} contacts not found in OpenAlex
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() =>
                  downloadBlob(enrichResult.blob, "kol_hubspot_enriched.csv")
                }
                className="bg-teal-primary text-white text-sm px-4 py-1.5 rounded hover:bg-teal-dark transition-colors"
              >
                Download Enriched CSV
              </button>

              {matchedCount > 0 && !profiles && (
                <button
                  onClick={generateProfiles}
                  disabled={profiling}
                  className="bg-purple-600 text-white text-sm px-4 py-1.5 rounded hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {profiling ? "Generating..." : `Generate AI Profiles (${matchedCount})`}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Profile progress */}
        {profiling && profileProgress && (
          <div className="mt-3 bg-purple-50 border border-purple-200 rounded-lg p-4">
            <div className="flex items-center gap-3">
              <div className="w-5 h-5 border-2 border-purple-600 border-t-transparent rounded-full animate-spin" />
              <div>
                <p className="text-sm font-medium text-purple-800">
                  Generating AI profiles...
                </p>
                <p className="text-xs text-purple-600">
                  Batch {profileProgress.batch} of {profileProgress.totalBatches}
                  {" "}({profileProgress.current}-
                  {Math.min(profileProgress.current + 9, profileProgress.total)} of{" "}
                  {profileProgress.total} KOLs)
                </p>
              </div>
            </div>
            <div className="mt-2 bg-purple-200 rounded-full h-1.5">
              <div
                className="bg-purple-600 h-1.5 rounded-full transition-all duration-300"
                style={{
                  width: `${(profileProgress.batch / profileProgress.totalBatches) * 100}%`,
                }}
              />
            </div>
          </div>
        )}

        {profileError && (
          <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-700">Profile error: {profileError}</p>
          </div>
        )}

        {/* Profile results */}
        {profiles && (
          <div className="mt-3 bg-purple-50 border border-purple-200 rounded-lg p-4 space-y-3">
            <p className="text-sm font-semibold text-purple-800">
              {profiles.filter((p) => p.status === "ok").length} of{" "}
              {profiles.length} profiles generated
            </p>

            {profiles.filter((p) => p.status === "error").length > 0 && (
              <p className="text-xs text-purple-600">
                {profiles.filter((p) => p.status === "error").length} failed
                (will show blank profile columns)
              </p>
            )}

            <button
              onClick={downloadWithProfiles}
              className="bg-purple-600 text-white text-sm px-4 py-1.5 rounded hover:bg-purple-700 transition-colors"
            >
              Download CSV with Profiles
            </button>

            {/* Preview first successful profile */}
            {profiles.find((p) => p.status === "ok") && (
              <details className="mt-2">
                <summary className="text-xs text-purple-700 cursor-pointer hover:text-purple-900">
                  Preview: {profiles.find((p) => p.status === "ok").display_name}
                </summary>
                <div className="mt-2 bg-white rounded p-3 text-xs text-gray-700 space-y-2">
                  {(() => {
                    const p = profiles.find((p) => p.status === "ok");
                    return (
                      <>
                        <div>
                          <span className="font-semibold text-gray-900">Outreach:</span>{" "}
                          {p.outreach_angle}
                        </div>
                        <div>
                          <span className="font-semibold text-gray-900">SME Briefing:</span>{" "}
                          {p.sme_briefing}
                        </div>
                        <div>
                          <span className="font-semibold text-gray-900">Nutrition Stance:</span>{" "}
                          {p.nutrition_stance_assessment?.level} — {p.nutrition_stance_assessment?.reasoning}
                        </div>
                        {p.red_flags?.length > 0 && (
                          <div>
                            <span className="font-semibold text-red-700">Red Flags:</span>{" "}
                            {p.red_flags.join("; ")}
                          </div>
                        )}
                        <div>
                          <span className="font-semibold text-gray-900">Tier Rationale:</span>{" "}
                          {p.tier_rationale}
                        </div>
                      </>
                    );
                  })()}
                </div>
              </details>
            )}
          </div>
        )}
      </section>

      {/* Export section */}
      <section>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">
          Export Pipeline Output
        </h3>
        <p className="text-xs text-gray-500 mb-3">
          Download the full KOL pipeline output as a HubSpot-ready import CSV
          with all OPS fields mapped to the correct column names.
        </p>
        <button
          onClick={exportFullPipeline}
          className="bg-teal-primary text-white text-sm px-4 py-2 rounded hover:bg-teal-dark transition-colors"
        >
          Download Full Export ({nodes.length} KOLs)
        </button>

        <div className="mt-4 bg-gray-50 rounded-lg p-3">
          <p className="text-xs font-semibold text-gray-600 mb-1">
            HubSpot Column Mapping
          </p>
          <div className="flex flex-wrap gap-1">
            {ALL_COLUMNS.map((col) => (
              <span
                key={col}
                className={`text-[10px] border rounded px-1.5 py-0.5 font-mono ${
                  PROFILE_COLUMNS.includes(col)
                    ? "bg-purple-50 border-purple-200 text-purple-700"
                    : "bg-white border-gray-200 text-gray-600"
                }`}
              >
                {col}
              </span>
            ))}
          </div>
          <p className="text-[10px] text-gray-400 mt-1">
            <span className="text-purple-600">Purple</span> = AI profile columns (requires Generate AI Profiles)
          </p>
        </div>
      </section>
    </div>
  );
}
