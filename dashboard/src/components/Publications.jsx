import { useState, useCallback } from "react";
import Papa from "papaparse";

function getApiHeaders() {
  const headers = {};
  const geminiKey = localStorage.getItem("kol_gemini_key");
  const email = localStorage.getItem("kol_openalex_email");
  if (geminiKey) headers["X-Gemini-Key"] = geminiKey;
  if (email) headers["X-OpenAlex-Email"] = email;
  return headers;
}

export default function Publications({ nodes }) {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [expandedIdx, setExpandedIdx] = useState(null);

  const checkPublications = useCallback(async () => {
    setLoading(true);
    setResults(null);
    setError(null);

    try {
      const kolPayload = nodes.map((n) => ({
        display_name: n.display_name || "",
        email: n.email || "",
        kol_tier: n.kol_tier || n.tier || "",
        institution: n.institution || "",
      }));

      const resp = await fetch("/api/publications", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getApiHeaders() },
        body: JSON.stringify(kolPayload),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(err.error || `Server error: ${resp.status}`);
      }

      const data = await resp.json();
      setResults(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [nodes]);

  function downloadCheckIns() {
    if (!results?.length) return;
    const csv = Papa.unparse(results, {
      columns: ["display_name", "email", "kol_tier", "institution",
        "paper_title", "paper_date", "subject_line", "email_body"],
    });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "kol_checkin_list.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const tierColor = {
    A: "bg-green-100 text-green-800",
    B: "bg-blue-100 text-blue-800",
    C: "bg-yellow-100 text-yellow-800",
    D: "bg-gray-100 text-gray-800",
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h2 className="text-lg font-bold text-gray-900">Publications</h2>
          <p className="text-xs text-gray-500 mt-1">
            Check PubMed for recent publications (last 30 days) by your KOLs.
            Generates a check-in email draft for each researcher who published
            recently.
          </p>
        </div>

        <button
          onClick={checkPublications}
          disabled={loading}
          className="bg-teal-primary text-white text-sm px-6 py-2 rounded hover:bg-teal-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Checking PubMed...
            </span>
          ) : (
            `Check for Recent Publications (${nodes.length} KOLs)`
          )}
        </button>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {results && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-gray-800">
                {results.length === 0
                  ? "No KOLs published in the last 30 days"
                  : `${results.length} KOL${results.length > 1 ? "s" : ""} published in the last 30 days`}
              </p>
              {results.length > 0 && (
                <button
                  onClick={downloadCheckIns}
                  className="text-xs text-teal-primary hover:text-teal-dark font-medium"
                >
                  Download CSV
                </button>
              )}
            </div>

            {results.map((item, idx) => (
              <div
                key={idx}
                className="bg-white border border-gray-200 rounded-lg overflow-hidden"
              >
                <div
                  className="p-4 cursor-pointer hover:bg-gray-50 transition-colors"
                  onClick={() =>
                    setExpandedIdx(expandedIdx === idx ? null : idx)
                  }
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                            tierColor[item.kol_tier] || tierColor.D
                          }`}
                        >
                          {item.kol_tier || "?"}
                        </span>
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {item.display_name}
                        </p>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {item.institution}
                      </p>
                      <p className="text-xs text-gray-700 mt-1 line-clamp-2">
                        {item.paper_title}
                      </p>
                    </div>
                    <span className="text-[10px] text-gray-400 shrink-0">
                      {item.paper_date}
                    </span>
                  </div>
                </div>

                {expandedIdx === idx && (
                  <div className="border-t border-gray-100 bg-gray-50 p-4 space-y-3">
                    {item.subject_line && (
                      <div>
                        <p className="text-[10px] font-semibold text-gray-500 uppercase mb-0.5">
                          Subject
                        </p>
                        <p className="text-sm text-gray-800">
                          {item.subject_line}
                        </p>
                      </div>
                    )}
                    <div>
                      <p className="text-[10px] font-semibold text-gray-500 uppercase mb-0.5">
                        Email Draft
                      </p>
                      <p className="text-sm text-gray-700 whitespace-pre-line">
                        {item.email_body}
                      </p>
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(
                            `Subject: ${item.subject_line}\n\n${item.email_body}`
                          );
                        }}
                        className="text-xs text-teal-primary hover:text-teal-dark font-medium"
                      >
                        Copy to clipboard
                      </button>
                      {item.email && (
                        <a
                          href={`mailto:${item.email}?subject=${encodeURIComponent(item.subject_line)}&body=${encodeURIComponent(item.email_body)}`}
                          className="text-xs text-teal-primary hover:text-teal-dark font-medium"
                        >
                          Open in email client
                        </a>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
