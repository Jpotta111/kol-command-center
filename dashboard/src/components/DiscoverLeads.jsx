import { useState, useCallback } from "react";
import Papa from "papaparse";

function getApiHeaders() {
  const headers = {};
  const geminiKey = localStorage.getItem("kol_gemini_key");
  if (geminiKey) headers["X-Gemini-Key"] = geminiKey;
  return headers;
}

const CONF_COLORS = {
  HIGH: "bg-green-100 text-green-800",
  MEDIUM: "bg-yellow-100 text-yellow-800",
  LOW: "bg-red-100 text-red-800",
};

const PRIORITY_COLORS = {
  High: "bg-red-50 text-red-700 border-red-200",
  Medium: "bg-yellow-50 text-yellow-700 border-yellow-200",
  Low: "bg-gray-50 text-gray-600 border-gray-200",
};

export default function DiscoverLeads({ existingContacts, onLeadsDiscovered }) {
  const [orgFile, setOrgFile] = useState(null);
  const [orgs, setOrgs] = useState(null);
  const [discovering, setDiscovering] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleOrgFile = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (parsed) => {
        // Normalize column names
        const rows = parsed.data.map((r) => ({
          organization_name: r.organization_name || r.Organization || r.name || r.Name || "",
          org_type: r.org_type || r["Org Type"] || r.type || "",
          priority: r.priority || r.Priority || "Medium",
          notes: r.notes || r.Notes || "",
        })).filter((r) => r.organization_name);
        setOrgs(rows);
        setOrgFile(file.name);
        setResult(null);
      },
    });
  }, []);

  const runDiscovery = useCallback(async () => {
    if (!orgs?.length) return;

    setDiscovering(true);
    setResult(null);
    setError(null);
    setProgress({ current: 0, total: orgs.length, org: orgs[0]?.organization_name });

    try {
      // Build existing contact names for dedup
      const existingNames = (existingContacts || []).map((c) => {
        if (typeof c === "string") return c;
        return c.display_name || c.name ||
          `${c.firstname || ""} ${c.lastname || ""}`.trim();
      }).filter(Boolean);

      const resp = await fetch("/api/discover-leads", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getApiHeaders() },
        body: JSON.stringify({
          organizations: orgs,
          existing_contacts: existingNames,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(err.error || `Server error: ${resp.status}`);
      }

      const data = await resp.json();
      setResult(data);

      // Pass net-new leads up for Pipeline integration
      if (onLeadsDiscovered && data.net_new_leads?.length) {
        onLeadsDiscovered(data.net_new_leads);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setDiscovering(false);
      setProgress(null);
    }
  }, [orgs, existingContacts, onLeadsDiscovered]);

  function downloadLeadsCSV() {
    if (!result?.net_new_leads?.length) return;
    const rows = result.net_new_leads.map((l) => {
      const nameParts = (l.full_name || "").split(/\s+/);
      return {
        firstname: nameParts[0] || "",
        lastname: nameParts.slice(1).join(" ") || "",
        company: l.organization || "",
        jobtitle: l.current_title || "",
        kol_type: "Commercial",
        commercial_pipeline_stage: "Prospect",
        linkedin_url: l.linkedin_url || "",
        data_confidence: l.data_confidence || "",
        discovery_source: l.source_url || "",
        discovered_date: l.discovered_date || "",
        sme_owner: "",
      };
    });
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "discovered_leads.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  function downloadDigest() {
    if (!result) return;
    const today = new Date().toLocaleDateString();
    const byOrg = {};
    for (const l of result.net_new_leads || []) {
      const org = l.organization || "Unknown";
      if (!byOrg[org]) byOrg[org] = [];
      byOrg[org].push(l);
    }
    const orgSections = Object.entries(byOrg).map(([org, leads]) =>
      `<h3 style="color:#00726B;margin:16px 0 8px">${org} (${leads.length} leads)</h3>
<table style="width:100%;border-collapse:collapse">
${leads.map((l) => `<tr style="border-bottom:1px solid #e5e7eb">
  <td style="padding:6px">${l.full_name}</td>
  <td style="padding:6px;color:#666">${l.current_title}</td>
  <td style="padding:6px"><span style="background:${l.data_confidence === "HIGH" ? "#dcfce7" : l.data_confidence === "MEDIUM" ? "#fef9c3" : "#fee2e2"};padding:2px 8px;border-radius:4px;font-size:11px">${l.data_confidence}</span></td>
</tr>`).join("")}
</table>`
    ).join("");

    const html = `<html><head><style>body{font-family:system-ui;max-width:700px;margin:0 auto;padding:24px}h2{color:#00726B}</style></head><body>
<h2>Commercial Lead Discovery Digest</h2>
<p style="color:#666">${today} | ${result.summary.organizations_searched} organizations searched</p>
<p><strong>${result.summary.net_new_leads} net-new leads</strong> found across ${result.summary.organizations_searched} organizations
(${result.summary.existing_contact_matches} already in HubSpot)</p>
${orgSections}
<p style="color:#999;font-size:12px;margin-top:24px">Generated by KOL Command Center</p>
</body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "lead_discovery_digest.html"; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-700">Discover Commercial Leads</h3>
      <p className="text-xs text-gray-500">
        Upload a Target Organizations CSV. Gemini + Google Search will find
        decision-makers at each org and deduplicate against your existing contacts.
      </p>

      {/* Org CSV upload */}
      <div className="flex items-center gap-3">
        <label className="bg-teal-primary text-white text-sm px-4 py-2 rounded cursor-pointer hover:bg-teal-dark transition-colors">
          {orgFile ? orgFile : "Upload Target Orgs CSV"}
          <input type="file" accept=".csv" onChange={handleOrgFile} className="hidden" />
        </label>
        {orgs && (
          <span className="text-xs text-gray-600">
            {orgs.length} organizations loaded
            {orgs.filter((o) => o.priority === "High").length > 0 &&
              ` (${orgs.filter((o) => o.priority === "High").length} high priority)`}
          </span>
        )}
      </div>

      {orgs && !discovering && !result && (
        <button
          onClick={runDiscovery}
          className="bg-purple-600 text-white text-sm px-6 py-2 rounded hover:bg-purple-700 transition-colors"
        >
          Discover Commercial Leads ({orgs.length} orgs)
        </button>
      )}

      {/* Progress */}
      {discovering && progress && (
        <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-purple-600 border-t-transparent rounded-full animate-spin" />
            <div>
              <p className="text-sm font-medium text-purple-800">Searching organizations...</p>
              <p className="text-xs text-purple-600">This may take a few minutes for large lists.</p>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-4">
          {/* Summary banner */}
          <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
            <p className="text-sm font-bold text-purple-800">
              Found {result.summary.net_new_leads} net-new leads across{" "}
              {result.summary.organizations_searched} organizations
            </p>
            <p className="text-xs text-purple-600 mt-1">
              {result.summary.total_leads_found} total identified |{" "}
              {result.summary.existing_contact_matches} already in HubSpot
            </p>
            <div className="flex gap-2 mt-3">
              <button onClick={downloadLeadsCSV}
                className="bg-purple-600 text-white text-xs px-3 py-1.5 rounded hover:bg-purple-700">
                Download CSV (HubSpot Import)
              </button>
              <button onClick={downloadDigest}
                className="bg-white text-purple-700 border border-purple-300 text-xs px-3 py-1.5 rounded hover:bg-purple-50">
                Download Weekly Digest
              </button>
            </div>
          </div>

          {/* Org breakdown */}
          <div className="space-y-2">
            {result.org_results?.map((org, i) => (
              <div key={i} className="flex items-center justify-between bg-white border border-gray-200 rounded px-3 py-2">
                <div>
                  <span className="text-sm font-medium text-gray-900">{org.organization}</span>
                  {org.error && <span className="text-xs text-red-500 ml-2">({org.error})</span>}
                </div>
                <div className="flex gap-3 text-xs text-gray-500">
                  <span>{org.leads_found} found</span>
                  <span className="font-semibold text-purple-700">{org.net_new} new</span>
                  {org.existing_matches > 0 && <span className="text-gray-400">{org.existing_matches} existing</span>}
                </div>
              </div>
            ))}
          </div>

          {/* Lead cards */}
          {result.net_new_leads?.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-700 mb-2">
                Net-New Leads ({result.net_new_leads.length})
              </h4>
              <div className="space-y-2">
                {result.net_new_leads.map((lead, i) => (
                  <div key={i} className="bg-white border border-gray-200 rounded-lg p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{lead.full_name}</p>
                        <p className="text-xs text-gray-600">{lead.current_title}</p>
                        <p className="text-xs text-gray-500">{lead.organization}</p>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        {lead.priority && (
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${PRIORITY_COLORS[lead.priority] || PRIORITY_COLORS.Medium}`}>
                            {lead.priority}
                          </span>
                        )}
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${CONF_COLORS[lead.data_confidence] || CONF_COLORS.LOW}`}>
                          {lead.data_confidence}
                        </span>
                      </div>
                    </div>
                    {lead.discovery_notes && (
                      <p className="text-[10px] text-gray-400 mt-1">{lead.discovery_notes}</p>
                    )}
                    {lead.linkedin_url && (
                      <a href={lead.linkedin_url} target="_blank" rel="noopener noreferrer"
                        className="text-[10px] text-blue-600 hover:underline mt-1 inline-block">
                        LinkedIn
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
