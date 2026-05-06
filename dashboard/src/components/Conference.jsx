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

const TIER_BADGE = {
  A: "bg-green-100 text-green-800",
  B: "bg-blue-100 text-blue-800",
  C: "bg-yellow-100 text-yellow-800",
  D: "bg-gray-100 text-gray-800",
};

const REL_BADGE = {
  virta_internal: "bg-teal-100 text-teal-800 border border-teal-300",
  existing_kol: "bg-purple-100 text-purple-800",
  net_new: "bg-amber-100 text-amber-800",
};

const REL_LABEL = {
  virta_internal: "Virta",
  existing_kol: "KOL",
  net_new: "Net-New",
};

const DEFAULT_FORM = {
  conference_name: "ISPOR 2026",
  conference_url:
    "https://www.ispor.org/conferences-education/conferences/upcoming-conferences/ispor-2026",
  conference_dates: "May 17-20, 2026, Philadelphia",
  year: 2026,
  presenter_name: "Your team presenter",
  presenter_abstract: "Your team presenter's abstract title",
  presenter_keywords:
    "T2D, obesity, telehealth, nutrition therapy, real world evidence",
};

export default function Conference({ existingKols = [] }) {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [uploadedKols, setUploadedKols] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const kolsForScan = uploadedKols || existingKols;

  const update = (field) => (e) =>
    setForm({ ...form, [field]: e.target.value });

  const handleKolUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (parsed) => setUploadedKols(parsed.data),
    });
  };

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    const presenters = [{
      name: form.presenter_name,
      abstract_title: form.presenter_abstract,
      abstract_keywords: form.presenter_keywords
        .split(",").map((k) => k.trim()).filter(Boolean),
    }];

    const payload = {
      conference_name: form.conference_name,
      conference_url: form.conference_url,
      conference_dates: form.conference_dates,
      year: parseInt(form.year, 10) || new Date().getFullYear(),
      virta_presenters: presenters,
      existing_kols: kolsForScan,
    };

    try {
      const resp = await fetch("/api/conference", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getApiHeaders() },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(err.error || `Server error: ${resp.status}`);
      }
      const data = await resp.json();
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [form, kolsForScan]);

  // ── Downloads ────────────────────────────────────────────────────────

  function downloadHTML(filename, html) {
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  function downloadNetNewCsv() {
    if (!result?.presenters?.length) return;
    const rows = result.presenters
      .filter((p) => p.relationship_type === "net_new")
      .map((p) => ({
        firstname: (p.full_name || "").split(" ")[0] || "",
        lastname: (p.full_name || "").split(" ").slice(1).join(" "),
        company: p.institution || "",
        kol_type: "Research",
        source: `${form.conference_name} session`,
        session_title: p.session_title || "",
        relevance: p.relevance_to_virta || "",
        recommended_action: p.recommended_action || "",
      }));
    if (!rows.length) return;
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${form.conference_name.replace(/\s+/g, "_")}_net_new_prospects.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadTeamBriefing() {
    if (!result) return;
    const html = renderTeamBriefingHtml(form, result);
    downloadHTML(
      `${form.conference_name.replace(/\s+/g, "_")}_team_briefing.html`,
      html,
    );
  }

  function downloadPersonalBriefing() {
    if (!result?.personal_briefing) return;
    const html = renderPersonalBriefingHtml(form, result);
    const safeName = (form.presenter_name || "presenter")
      .replace(/\s+/g, "_").toLowerCase();
    downloadHTML(
      `${form.conference_name.replace(/\s+/g, "_")}_briefing_for_${safeName}.html`,
      html,
    );
  }

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h2 className="text-lg font-bold text-gray-900">Conference Intelligence</h2>
          <p className="text-xs text-gray-500 mt-1">
            Scan a conference program for sessions and presenters relevant to Virta,
            cross-reference with existing KOLs, and generate briefings for the team
            and for any Virta presenter on-site.
          </p>
        </div>

        {/* Form */}
        <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Conference name" value={form.conference_name} onChange={update("conference_name")} />
            <Field label="Year" value={form.year} onChange={update("year")} />
          </div>
          <Field label="Conference URL" value={form.conference_url} onChange={update("conference_url")} />
          <Field label="Dates / Location" value={form.conference_dates} onChange={update("conference_dates")} />
          <div className="border-t border-gray-100 pt-3">
            <p className="text-xs font-semibold text-gray-700 mb-2">Virta presenter (excluded from outreach)</p>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Name" value={form.presenter_name} onChange={update("presenter_name")} />
              <div className="col-span-2">
                <TextArea label="Abstract title" rows={2} value={form.presenter_abstract} onChange={update("presenter_abstract")} />
              </div>
            </div>
            <Field
              label="Keywords (comma-separated)"
              value={form.presenter_keywords}
              onChange={update("presenter_keywords")}
            />
          </div>
          <div className="border-t border-gray-100 pt-3">
            <label className="block text-xs font-semibold text-gray-700 mb-1">
              Existing KOLs for cross-reference
            </label>
            <div className="flex items-center gap-3 text-xs">
              <label className="bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded cursor-pointer text-gray-700">
                Upload KOL CSV
                <input type="file" accept=".csv" onChange={handleKolUpload} className="hidden" />
              </label>
              <span className="text-gray-500">
                {uploadedKols
                  ? `Using ${uploadedKols.length} KOLs from upload`
                  : `Using ${existingKols.length} KOLs from current session`}
              </span>
              {uploadedKols && (
                <button
                  className="text-teal-primary hover:text-teal-dark"
                  onClick={() => setUploadedKols(null)}
                >
                  Reset
                </button>
              )}
            </div>
          </div>
          <div className="pt-2">
            <button
              onClick={scan}
              disabled={loading}
              className="bg-teal-primary text-white text-sm px-6 py-2 rounded hover:bg-teal-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Scanning conference (this may take 30-60s)...
                </span>
              ) : (
                "Scan Conference"
              )}
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {result && (
          <ResultPanel
            result={result}
            form={form}
            onDownloadTeam={downloadTeamBriefing}
            onDownloadPersonal={downloadPersonalBriefing}
            onDownloadNetNewCsv={downloadNetNewCsv}
          />
        )}
      </div>
    </div>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────────

function Field({ label, value, onChange }) {
  return (
    <label className="block text-xs">
      <span className="font-semibold text-gray-700">{label}</span>
      <input
        type="text"
        value={value}
        onChange={onChange}
        className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-teal-primary"
      />
    </label>
  );
}

function TextArea({ label, value, onChange, rows = 3 }) {
  return (
    <label className="block text-xs">
      <span className="font-semibold text-gray-700">{label}</span>
      <textarea
        rows={rows}
        value={value}
        onChange={onChange}
        className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-teal-primary"
      />
    </label>
  );
}

function ResultPanel({ result, form, onDownloadTeam, onDownloadPersonal, onDownloadNetNewCsv }) {
  const { summary, presenters, team_briefing, personal_briefing } = result;

  return (
    <div className="space-y-6">
      {/* Summary banner */}
      <div className="bg-teal-50 border border-teal-200 rounded-lg p-4">
        <div className="flex flex-wrap gap-6 text-sm">
          <Stat label="Relevant sessions" value={summary.total_relevant_sessions} />
          <Stat label="Existing KOLs presenting" value={summary.existing_kols_presenting} color="text-purple-700" />
          <Stat label="Net-new prospects" value={summary.net_new_prospects} color="text-amber-700" />
          <Stat label="Virta presenters found" value={summary.virta_presenters_found} color="text-teal-primary" />
        </div>
        <div className="mt-3 flex flex-wrap gap-2 pt-3 border-t border-teal-200">
          <button
            onClick={onDownloadTeam}
            className="text-xs bg-teal-primary text-white px-3 py-1.5 rounded hover:bg-teal-dark"
          >
            Download Team Briefing (HTML)
          </button>
          <button
            onClick={onDownloadPersonal}
            className="text-xs bg-white border border-teal-primary text-teal-primary px-3 py-1.5 rounded hover:bg-teal-50"
          >
            Download {form.presenter_name}'s Briefing (HTML)
          </button>
          <button
            onClick={onDownloadNetNewCsv}
            className="text-xs bg-white border border-amber-400 text-amber-700 px-3 py-1.5 rounded hover:bg-amber-50"
          >
            Download Net-New CSV
          </button>
        </div>
      </div>

      {/* Top sessions to attend */}
      {team_briefing?.top_sessions?.length > 0 && (
        <Section title="Top Sessions to Attend">
          <ul className="space-y-2">
            {team_briefing.top_sessions.slice(0, 5).map((s, i) => (
              <li key={i} className="bg-white border border-gray-200 rounded p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm font-semibold text-gray-900">{s.session_title}</p>
                  <span className="text-[10px] text-gray-500 shrink-0">{s.session_date_time}</span>
                </div>
                {s.lead_presenter && <p className="text-xs text-gray-600 mt-0.5">{s.lead_presenter} · {s.session_track}</p>}
                <p className="text-xs text-gray-700 mt-1">{s.why_attend}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Existing KOLs presenting */}
      {team_briefing?.existing_kols_presenting?.length > 0 && (
        <Section title={`Existing KOLs Presenting (${team_briefing.existing_kols_presenting.length})`}>
          <ul className="space-y-2">
            {team_briefing.existing_kols_presenting.map((p, i) => (
              <PresenterCard key={i} presenter={p} />
            ))}
          </ul>
        </Section>
      )}

      {/* Net-new prospects */}
      {team_briefing?.net_new_prospects?.length > 0 && (
        <Section title={`Net-New Prospects (${team_briefing.net_new_prospects.length})`}>
          <ul className="space-y-2">
            {team_briefing.net_new_prospects.map((p, i) => (
              <PresenterCard key={i} presenter={p} />
            ))}
          </ul>
        </Section>
      )}

      {/* Virta presenters found at conference */}
      {team_briefing?.virta_presenters_at_conference?.length > 0 && (
        <Section title="Virta Presenters at Conference">
          <ul className="space-y-2">
            {team_briefing.virta_presenters_at_conference.map((p, i) => (
              <PresenterCard key={i} presenter={p} />
            ))}
          </ul>
        </Section>
      )}

      {/* Personal briefing preview */}
      {personal_briefing && (
        <Section title={`Personal Briefing — ${personal_briefing.presenter?.name || "Presenter"}`}>
          <div className="text-xs text-gray-600 mb-2">
            People {personal_briefing.presenter?.name || "the presenter"} should connect
            with at the conference. Download the full briefing using the button above.
          </div>
          <BriefingSubsection title="Adjacent sessions" items={personal_briefing.adjacent_sessions} />
          <BriefingSubsection title="Method matches (PSM, RWE, survival analysis)" items={personal_briefing.method_matches} />
          <BriefingSubsection title="Telehealth / digital health sessions" items={personal_briefing.telehealth_sessions} />
          <BriefingSubsection title="Existing Virta KOLs presenting" items={personal_briefing.existing_kol_meetups} />
        </Section>
      )}

      {/* All presenters table */}
      {presenters.length > 0 && (
        <Section title={`All Presenters Found (${presenters.length})`}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-gray-100 text-left">
                  <th className="px-2 py-1.5">Type</th>
                  <th className="px-2 py-1.5">Name</th>
                  <th className="px-2 py-1.5">Institution</th>
                  <th className="px-2 py-1.5">Session</th>
                  <th className="px-2 py-1.5">Action</th>
                </tr>
              </thead>
              <tbody>
                {presenters.map((p, i) => (
                  <tr key={i} className="border-b border-gray-100 hover:bg-gray-50 align-top">
                    <td className="px-2 py-1.5">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${REL_BADGE[p.relationship_type] || ""}`}>
                        {REL_LABEL[p.relationship_type] || p.relationship_type}
                      </span>
                      {p.existing_kol_tier && (
                        <span className={`ml-1 text-[10px] px-1 py-0.5 rounded ${TIER_BADGE[p.existing_kol_tier] || ""}`}>
                          {p.existing_kol_tier}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 font-medium text-gray-900">{p.full_name}</td>
                    <td className="px-2 py-1.5 text-gray-600">{p.institution}</td>
                    <td className="px-2 py-1.5 text-gray-700">{p.session_title}</td>
                    <td className="px-2 py-1.5 text-gray-600">{p.recommended_action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </div>
  );
}

function Stat({ label, value, color = "text-gray-900" }) {
  return (
    <div>
      <span className="text-gray-500">{label}: </span>
      <span className={`font-bold ${color}`}>{value}</span>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <h3 className="text-sm font-bold text-gray-900 mb-2">{title}</h3>
      {children}
    </div>
  );
}

function PresenterCard({ presenter }) {
  const p = presenter;
  return (
    <li className="bg-white border border-gray-200 rounded p-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-sm font-semibold text-gray-900 truncate">{p.full_name}</p>
          {p.existing_kol_tier && (
            <span className={`text-[10px] font-bold px-1 py-0.5 rounded ${TIER_BADGE[p.existing_kol_tier] || ""}`}>
              {p.existing_kol_tier}
            </span>
          )}
          {p.existing_kol_sme_owner && (
            <span className="text-[10px] text-gray-500">SME: {p.existing_kol_sme_owner}</span>
          )}
        </div>
        <span className="text-[10px] text-gray-500 shrink-0">{p.session_date_time}</span>
      </div>
      {p.institution && <p className="text-xs text-gray-600 mt-0.5">{p.institution}</p>}
      {p.session_title && <p className="text-xs text-gray-700 mt-1 italic">{p.session_title}</p>}
      {p.relevance_to_virta && <p className="text-xs text-gray-700 mt-1">{p.relevance_to_virta}</p>}
      {p.adjacency_to_team_abstract && (
        <p className="text-xs text-teal-700 mt-1">
          <span className="font-semibold">Adjacent: </span>{p.adjacency_to_team_abstract}
        </p>
      )}
      {p.conversation_opener && (
        <details className="mt-1.5">
          <summary className="text-[10px] text-teal-primary cursor-pointer hover:text-teal-dark">
            Conversation opener
          </summary>
          <p className="text-xs text-gray-700 mt-1 bg-gray-50 p-2 rounded">{p.conversation_opener}</p>
        </details>
      )}
      <p className="text-[10px] text-gray-500 mt-1">→ {p.recommended_action}</p>
    </li>
  );
}

function BriefingSubsection({ title, items }) {
  if (!items?.length) return null;
  return (
    <div className="mt-3">
      <p className="text-xs font-semibold text-gray-700 mb-1">{title} ({items.length})</p>
      <ul className="space-y-1">
        {items.slice(0, 5).map((p, i) => (
          <li key={i} className="text-xs text-gray-700 pl-2 border-l-2 border-teal-200">
            <span className="font-medium">{p.full_name}</span>
            {p.institution && <span className="text-gray-500"> · {p.institution}</span>}
            {p.session_title && <div className="italic text-gray-600">{p.session_title}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── HTML briefing generators ──────────────────────────────────────────

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const HTML_BASE_CSS = `
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 780px; margin: 24px auto; padding: 0 24px; color: #1f2937; line-height: 1.5; }
  h1 { color: #00726B; font-size: 22px; margin-bottom: 4px; }
  h2 { color: #00726B; font-size: 16px; margin-top: 24px; border-bottom: 2px solid #00726B; padding-bottom: 4px; }
  h3 { font-size: 14px; margin-top: 16px; color: #374151; }
  .meta { color: #6b7280; font-size: 12px; margin-bottom: 16px; }
  .session { border-left: 3px solid #00726B; padding: 8px 12px; margin: 8px 0; background: #f0fdfa; }
  .session .title { font-weight: 600; }
  .session .meta-line { font-size: 11px; color: #6b7280; }
  .session .relevance { font-size: 12px; margin-top: 4px; }
  .badge { display: inline-block; font-size: 10px; padding: 2px 6px; border-radius: 4px; margin-right: 4px; }
  .badge.tier-a { background: #d1fae5; color: #065f46; }
  .badge.tier-b { background: #dbeafe; color: #1e40af; }
  .badge.kol { background: #ede9fe; color: #5b21b6; }
  .badge.netnew { background: #fef3c7; color: #92400e; }
  .badge.virta { background: #ccfbf1; color: #115e59; }
  .email { background: #f9fafb; border: 1px solid #e5e7eb; padding: 12px; margin: 8px 0; border-radius: 4px; font-size: 12px; white-space: pre-wrap; font-family: ui-monospace, monospace; }
  .summary-box { background: #f0fdfa; border: 1px solid #99f6e4; padding: 12px; border-radius: 4px; margin: 12px 0; font-size: 13px; }
`;

function relBadge(rel) {
  const cls = rel === "existing_kol" ? "kol" :
              rel === "virta_internal" ? "virta" : "netnew";
  const lbl = rel === "existing_kol" ? "Existing KOL" :
              rel === "virta_internal" ? "Virta" : "Net-New";
  return `<span class="badge ${cls}">${lbl}</span>`;
}

function tierBadge(tier) {
  if (!tier) return "";
  const cls = tier === "A" ? "tier-a" : tier === "B" ? "tier-b" : "";
  return `<span class="badge ${cls}">Tier ${escHtml(tier)}</span>`;
}

function sessionBlock(p) {
  return `
    <div class="session">
      <div class="title">${escHtml(p.full_name || "")} ${relBadge(p.relationship_type)}${tierBadge(p.existing_kol_tier)}</div>
      <div class="meta-line">${escHtml(p.institution || "")}${p.session_date_time ? " · " + escHtml(p.session_date_time) : ""}${p.session_track ? " · " + escHtml(p.session_track) : ""}</div>
      ${p.session_title ? `<div style="font-style:italic;font-size:12px;margin-top:4px;">${escHtml(p.session_title)}</div>` : ""}
      ${p.relevance_to_virta ? `<div class="relevance"><strong>Why it matters:</strong> ${escHtml(p.relevance_to_virta)}</div>` : ""}
      ${p.adjacency_to_team_abstract ? `<div class="relevance" style="color:#0f766e;"><strong>Adjacent:</strong> ${escHtml(p.adjacency_to_team_abstract)}</div>` : ""}
      ${p.conversation_opener ? `<div class="relevance"><strong>Opener:</strong> ${escHtml(p.conversation_opener)}</div>` : ""}
      ${p.recommended_action ? `<div class="meta-line" style="margin-top:4px;">→ ${escHtml(p.recommended_action)}</div>` : ""}
    </div>`;
}

function renderTeamBriefingHtml(form, result) {
  const { summary, team_briefing } = result;
  const top = team_briefing?.top_sessions || [];
  const existing = team_briefing?.existing_kols_presenting || [];
  const netNew = team_briefing?.net_new_prospects || [];
  const virta = team_briefing?.virta_presenters_at_conference || [];
  const requests = team_briefing?.meeting_requests || [];

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escHtml(form.conference_name)} — Team Briefing</title>
<style>${HTML_BASE_CSS}</style></head><body>
  <h1>${escHtml(form.conference_name)} — Team Briefing</h1>
  <div class="meta">${escHtml(form.conference_dates)}<br>For: Jared, Frank, Stan, Diego &middot; Generated ${new Date().toLocaleDateString()}</div>

  <div class="summary-box">
    <strong>Summary:</strong> ${summary.total_relevant_sessions} relevant sessions found.
    ${summary.existing_kols_presenting} existing KOLs presenting,
    ${summary.net_new_prospects} net-new prospects,
    ${summary.virta_presenters_found} Virta presenter${summary.virta_presenters_found === 1 ? "" : "s"} at conference.
  </div>

  ${top.length ? `<h2>Top ${Math.min(5, top.length)} Sessions to Attend</h2>
    ${top.slice(0, 5).map((s, i) => `
      <div class="session">
        <div class="title">${i + 1}. ${escHtml(s.session_title || "")}</div>
        <div class="meta-line">${escHtml(s.lead_presenter || "")}${s.session_date_time ? " · " + escHtml(s.session_date_time) : ""}${s.session_track ? " · " + escHtml(s.session_track) : ""}</div>
        ${s.why_attend ? `<div class="relevance">${escHtml(s.why_attend)}</div>` : ""}
      </div>`).join("")}` : ""}

  ${existing.length ? `<h2>Existing KOLs Presenting</h2>
    ${existing.map(sessionBlock).join("")}` : ""}

  ${netNew.length ? `<h2>Net-New Prospects</h2>
    ${netNew.map(sessionBlock).join("")}` : ""}

  ${virta.length ? `<h2>Virta Presenters On-Site</h2>
    ${virta.map(sessionBlock).join("")}` : ""}

  ${requests.length ? `<h2>Draft Meeting-Request Emails (Top ${requests.length})</h2>
    ${requests.map((r) => `
      <div>
        <h3>To: ${escHtml(r.to_name)}${r.institution ? ` · ${escHtml(r.institution)}` : ""}</h3>
        <div class="meta-line">Subject: ${escHtml(r.subject_line)}</div>
        <div class="email">${escHtml(r.body)}</div>
      </div>`).join("")}` : ""}

</body></html>`;
}

function renderPersonalBriefingHtml(form, result) {
  const b = result.personal_briefing;
  if (!b) return `<html><body><p>No personal briefing generated.</p></body></html>`;
  const presenter = b.presenter || {};

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escHtml(form.conference_name)} — Briefing for ${escHtml(presenter.name || "Presenter")}</title>
<style>${HTML_BASE_CSS}</style></head><body>
  <h1>${escHtml(form.conference_name)} — Personal Briefing</h1>
  <div class="meta">For: ${escHtml(presenter.name || "")} &middot; ${escHtml(form.conference_dates)} &middot; Generated ${new Date().toLocaleDateString()}</div>

  <div class="summary-box">
    <strong>Your abstract:</strong> ${escHtml(presenter.abstract_title || "")}
  </div>

  <p style="font-size:13px;">Below are people presenting at ${escHtml(form.conference_name)} who you should
  consider connecting with on-site. Each is grouped by why they are relevant to your work.</p>

  ${b.adjacent_sessions?.length ? `<h2>Adjacent sessions (same topic area)</h2>
    ${b.adjacent_sessions.map(sessionBlock).join("")}` : ""}

  ${b.method_matches?.length ? `<h2>Methods overlap (PSM, RWE, survival analysis)</h2>
    ${b.method_matches.map(sessionBlock).join("")}` : ""}

  ${b.telehealth_sessions?.length ? `<h2>Telehealth / digital health programs</h2>
    ${b.telehealth_sessions.map(sessionBlock).join("")}` : ""}

  ${b.existing_kol_meetups?.length ? `<h2>Existing Virta KOLs to greet in person</h2>
    ${b.existing_kol_meetups.map(sessionBlock).join("")}` : ""}

  ${(!b.adjacent_sessions?.length && !b.method_matches?.length && !b.telehealth_sessions?.length && !b.existing_kol_meetups?.length)
    ? `<p style="color:#6b7280;font-style:italic;">No adjacent presenters were identified by the conference scan.</p>` : ""}

</body></html>`;
}
