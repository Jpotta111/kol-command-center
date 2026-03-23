import { useState, useCallback } from "react";
import Papa from "papaparse";

const HUBSPOT_COLUMNS = [
  "hs_object_id", "ops_score", "kol_tier", "scientific_influence_score",
  "clinical_alignment_score", "pharma_entanglement_score", "openalex_id",
  "orcid", "top_paper_title", "top_paper_doi", "h_index", "citation_count",
  "institution", "nutrition_signal_keywords", "last_profiled_date",
  "nutrition_stance", "nutrition_stance_source",
];

function downloadCSV(rows, filename) {
  const csv = Papa.unparse(rows, { columns: HUBSPOT_COLUMNS });
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function matchContacts(hubspotRows, kolNodes) {
  const results = [];
  let matched = 0;

  for (const contact of hubspotRows) {
    const name = `${contact.firstname || ""} ${contact.lastname || ""}`.trim().toLowerCase();
    const email = (contact.email || "").toLowerCase();

    // Try matching by name
    const match = kolNodes.find((n) => {
      const kolName = n.display_name.toLowerCase();
      return kolName === name || kolName.includes(name) || name.includes(kolName);
    });

    if (match) {
      matched++;
      results.push({
        hs_object_id: contact.hs_object_id || contact.vid || "",
        ops_score: match.ops_score,
        kol_tier: match.tier,
        scientific_influence_score: match.scientific_influence_score,
        clinical_alignment_score: match.clinical_alignment_score,
        pharma_entanglement_score: match.strategic_value_score,
        openalex_id: match.openalex_id,
        orcid: "",
        top_paper_title: "",
        top_paper_doi: "",
        h_index: match.h_index,
        citation_count: match.citation_count,
        institution: match.institution || "",
        nutrition_signal_keywords: "",
        last_profiled_date: new Date().toISOString().split("T")[0],
        nutrition_stance: "",
        nutrition_stance_source: "",
      });
    }
  }

  return { results, matched, total: hubspotRows.length };
}

export default function CSVImportExport({ nodes }) {
  const [dragOver, setDragOver] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [enrichedRows, setEnrichedRows] = useState(null);

  const handleFile = useCallback(
    (file) => {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (result) => {
          const { results, matched, total } = matchContacts(result.data, nodes);
          setImportResult({ matched, total });
          setEnrichedRows(results);
        },
      });
    },
    [nodes]
  );

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

  return (
    <div className="h-full p-6 flex flex-col gap-6 max-w-3xl mx-auto">
      <h2 className="text-lg font-bold text-gray-900">CSV Import / Export</h2>

      {/* Import section */}
      <section>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">
          Import HubSpot Contacts
        </h3>
        <p className="text-xs text-gray-500 mb-3">
          Upload a HubSpot contact export CSV. Contacts will be matched to KOLs
          by name, and hs_object_id will be filled automatically.
        </p>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
            dragOver
              ? "border-teal-primary bg-teal-light"
              : "border-gray-300 bg-white hover:border-gray-400"
          }`}
        >
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
        </div>

        {importResult && (
          <div className="mt-3 bg-gray-50 rounded-lg p-4">
            <p className="text-sm font-semibold text-gray-800">
              Matched {importResult.matched} of {importResult.total} contacts
            </p>
            {enrichedRows && enrichedRows.length > 0 && (
              <>
                <p className="text-xs text-gray-500 mt-1">
                  {enrichedRows.length} enriched rows ready for download
                </p>
                <button
                  onClick={() => downloadCSV(enrichedRows, "kol_hubspot_enriched.csv")}
                  className="mt-2 bg-teal-primary text-white text-sm px-4 py-1.5 rounded hover:bg-teal-dark transition-colors"
                >
                  Download Enriched CSV
                </button>
              </>
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
            {HUBSPOT_COLUMNS.map((col) => (
              <span
                key={col}
                className="text-[10px] bg-white border border-gray-200 rounded px-1.5 py-0.5 text-gray-600 font-mono"
              >
                {col}
              </span>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
