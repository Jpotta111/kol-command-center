import { useState, useCallback } from "react";

function getApiHeaders() {
  const headers = {};
  const geminiKey = localStorage.getItem("kol_gemini_key");
  if (geminiKey) headers["X-Gemini-Key"] = geminiKey;
  return headers;
}

const VERDICT_COLORS = {
  "Pass — Defensible": { bg: "bg-green-50", border: "border-green-300", text: "text-green-800", badge: "bg-green-600" },
  "Minor Revision Needed": { bg: "bg-yellow-50", border: "border-yellow-300", text: "text-yellow-800", badge: "bg-yellow-600" },
  "Major Revision Needed": { bg: "bg-orange-50", border: "border-orange-300", text: "text-orange-800", badge: "bg-orange-600" },
  "Reject — Not Defensible": { bg: "bg-red-50", border: "border-red-300", text: "text-red-800", badge: "bg-red-600" },
};

const DOMAIN_META = [
  { key: "accuracy", label: "Accuracy", max: 30 },
  { key: "evidence_alignment", label: "Evidence Alignment", max: 25 },
  { key: "claim_strength", label: "Claim Strength", max: 20 },
  { key: "context_qualifiers", label: "Context & Qualifiers", max: 15 },
  { key: "citation_quality", label: "Citation Quality", max: 10 },
];

export default function CREDReview() {
  const [inputText, setInputText] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleSubmit = useCallback(async () => {
    if (!inputText.trim()) return;

    setReviewing(true);
    setResult(null);
    setError(null);

    try {
      const resp = await fetch("/api/cred-review", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getApiHeaders() },
        body: JSON.stringify({ text: inputText }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(err.error || `Server error: ${resp.status}`);
      }

      const review = await resp.json();
      setResult(review);
    } catch (err) {
      setError(err.message);
    } finally {
      setReviewing(false);
    }
  }, [inputText]);

  const handleFileDrop = useCallback((e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0] || e.target?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setInputText(ev.target.result);
    reader.readAsText(file);
  }, []);

  const vc = VERDICT_COLORS[result?.verdict] || VERDICT_COLORS["Major Revision Needed"];

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h2 className="text-lg font-bold text-gray-900">CRED Review</h2>
          <p className="text-xs text-gray-500 mt-1">
            Claims Review for Evidence & Defensibility. Paste a scientific claim,
            marketing asset, or full document below. Gemini will score it against
            Medical Affairs defensibility standards.
          </p>
        </div>

        {/* Input area */}
        <div>
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onDrop={handleFileDrop}
            onDragOver={(e) => e.preventDefault()}
            placeholder="Paste your claim, marketing copy, or scientific asset here...&#10;&#10;Or drag and drop a .txt file."
            className="w-full h-48 border border-gray-300 rounded-lg p-4 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-teal-primary focus:border-transparent"
          />
          <div className="flex items-center gap-3 mt-2">
            <button
              onClick={handleSubmit}
              disabled={reviewing || !inputText.trim()}
              className="bg-teal-primary text-white text-sm px-6 py-2 rounded hover:bg-teal-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {reviewing ? (
                <span className="flex items-center gap-2">
                  <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Reviewing...
                </span>
              ) : (
                "Run CRED Review"
              )}
            </button>
            <label className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
              Upload file
              <input
                type="file"
                accept=".txt,.md,.csv"
                onChange={handleFileDrop}
                className="hidden"
              />
            </label>
            {inputText && (
              <button
                onClick={() => { setInputText(""); setResult(null); setError(null); }}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-4">
            {/* Score + verdict banner */}
            <div className={`${vc.bg} border ${vc.border} rounded-lg p-5 flex items-center justify-between`}>
              <div>
                <p className={`text-2xl font-bold ${vc.text}`}>
                  {result.cred_score}/100
                </p>
                <p className={`text-sm font-medium ${vc.text} mt-1`}>
                  {result.verdict}
                </p>
              </div>
              <span className={`${vc.badge} text-white text-xs font-bold px-3 py-1 rounded-full`}>
                CRED
              </span>
            </div>

            {/* Summary */}
            {result.summary && (
              <div className="bg-white border border-gray-200 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-gray-800 mb-1">Summary</h3>
                <p className="text-sm text-gray-700">{result.summary}</p>
              </div>
            )}

            {/* Domain scores */}
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-800 mb-3">Domain Scores</h3>
              <div className="space-y-3">
                {DOMAIN_META.map(({ key, label, max }) => {
                  const domain = result.domain_scores?.[key];
                  if (!domain) return null;
                  const pct = (domain.score / max) * 100;
                  const barColor = pct >= 75 ? "bg-green-500" : pct >= 50 ? "bg-yellow-500" : pct >= 25 ? "bg-orange-500" : "bg-red-500";
                  return (
                    <div key={key}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="font-medium text-gray-700">{label}</span>
                        <span className="text-gray-500">{domain.score}/{max}</span>
                      </div>
                      <div className="bg-gray-100 rounded-full h-2 mb-1">
                        <div className={`${barColor} h-2 rounded-full transition-all`} style={{ width: `${pct}%` }} />
                      </div>
                      <p className="text-[11px] text-gray-500">{domain.rationale}</p>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Flagged items */}
            {result.flagged_items?.length > 0 && (
              <div className="bg-white border border-gray-200 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-gray-800 mb-3">
                  Flagged Claims ({result.flagged_items.length})
                </h3>
                <div className="space-y-3">
                  {result.flagged_items.map((item, i) => {
                    const sevColor = item.severity === "high" ? "bg-red-100 text-red-700 border-red-200" : item.severity === "medium" ? "bg-yellow-100 text-yellow-700 border-yellow-200" : "bg-blue-100 text-blue-700 border-blue-200";
                    return (
                      <div key={i} className={`border rounded-lg p-3 ${sevColor}`}>
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-xs font-medium">
                            &ldquo;{item.claim}&rdquo;
                          </p>
                          <span className="text-[10px] font-bold uppercase shrink-0">
                            {item.severity}
                          </span>
                        </div>
                        <p className="text-xs mt-1 opacity-80">{item.issue}</p>
                        {item.suggested_rewrite && (
                          <div className="mt-2 bg-white/60 rounded p-2">
                            <p className="text-[10px] font-semibold uppercase text-gray-500 mb-0.5">
                              Suggested rewrite
                            </p>
                            <p className="text-xs">{item.suggested_rewrite}</p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Recommendations */}
            {result.recommendations?.length > 0 && (
              <div className="bg-white border border-gray-200 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-gray-800 mb-2">
                  Required Changes
                </h3>
                <ol className="list-decimal list-inside space-y-1">
                  {result.recommendations.map((rec, i) => (
                    <li key={i} className="text-sm text-gray-700">{rec}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
