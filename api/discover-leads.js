/**
 * Vercel serverless function: Commercial lead discovery via Google Search grounding.
 *
 * POST /api/discover-leads
 * Body: { organizations: [...], existing_contacts: [...] }
 * Headers: X-Gemini-Key
 *
 * For each target org, uses Gemini 2.5 Flash with Google Search to find
 * decision-makers, then deduplicates against existing HubSpot contacts.
 */

const GEMINI_MODEL = "gemini-2.5-flash";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fuzzy name matching for dedup ──────────────────────────────────────

function normalizeNameTokens(name) {
  return name.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean);
}

function nameSimilarity(a, b) {
  const ta = normalizeNameTokens(a);
  const tb = normalizeNameTokens(b);
  if (!ta.length || !tb.length) return 0;
  let matches = 0;
  for (const t of ta) {
    if (tb.includes(t)) matches++;
  }
  return matches / Math.max(ta.length, tb.length);
}

function isExistingContact(name, existingNames) {
  for (const existing of existingNames) {
    if (nameSimilarity(name, existing) > 0.8) return true;
  }
  return false;
}

// ── Gemini search for decision-makers ──────────────────────────────────

async function discoverLeadsForOrg(org, apiKey) {
  const orgName = org.organization_name || org.name || "";
  const orgType = org.org_type || org.type || "";
  const priority = org.priority || "Medium";
  const notes = org.notes || "";

  if (!orgName) return [];

  // Build role-specific search queries
  const roleQueries = [
    `${orgName} Chief Medical Officer OR Medical Director 2025 2026`,
    `${orgName} VP Benefits OR Head of Benefits OR Benefits Director`,
    `${orgName} Head of Population Health OR Population Health Director`,
  ];

  // Add pharmacy-specific roles for PBMs and health plans
  if (["PBM", "Health Plan"].includes(orgType)) {
    roleQueries.push(`${orgName} pharmacy director OR formulary director`);
  }

  const prompt = `Search for key decision-makers at "${orgName}" (${orgType || "organization"}).
${notes ? `Context: ${notes}` : ""}

Search for these types of people:
${roleQueries.map((q, i) => `${i + 1}. ${q}`).join("\n")}

For each person you find with reasonable confidence, extract their information.
Only include people you can confirm currently work at or recently worked at ${orgName}.

Respond with ONLY valid JSON — an array of person objects:
[
  {
    "full_name": "First Last",
    "current_title": "their current job title",
    "organization": "${orgName}",
    "linkedin_url": "LinkedIn URL if found, otherwise empty string",
    "source_url": "URL where this person was found/confirmed",
    "data_confidence": "HIGH if multiple confirming sources, MEDIUM if one source, LOW if uncertain",
    "discovery_notes": "one sentence on how/where they were found"
  }
]

If no decision-makers can be found with confidence, return an empty array [].
Do NOT make up names. Only return real people you found via search.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Gemini ${resp.status}: ${err?.error?.message || resp.statusText}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";

  let leads;
  try {
    leads = JSON.parse(text.trim());
    if (!Array.isArray(leads)) leads = [];
  } catch {
    leads = [];
  }

  // Annotate with org metadata
  const today = new Date().toISOString().split("T")[0];
  return leads.map((lead) => ({
    ...lead,
    org_type: orgType,
    priority,
    kol_type: "Commercial",
    pipeline_stage: "Prospect",
    discovered_date: today,
  }));
}

// ── Main handler ───────────────────────────────────────────────────────

export default async function handler(req, res) {
  const origin = req.headers.origin || req.headers.get?.("origin") || "*";
  const corsHeaders = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Gemini-Key, X-OpenAlex-Email",
  };

  if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders); res.end(); return; }
  if (req.method !== "POST") {
    res.writeHead(405, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" })); return;
  }

  try {
    const apiKey = req.headers["x-gemini-key"] || process.env.GEMINI_API_KEY || "";
    if (!apiKey) {
      res.writeHead(401, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Gemini API key required. Please add it in Settings." }));
      return;
    }

    let body;
    if (typeof req.body === "object" && req.body !== null) {
      body = req.body;
    } else {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      }
      body = JSON.parse(chunks.join(""));
    }

    const organizations = body.organizations || [];
    const existingContacts = body.existing_contacts || [];

    if (!organizations.length) {
      res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No organizations provided." })); return;
    }

    // Normalize existing contact names for dedup
    const existingNames = existingContacts.map((c) => {
      if (typeof c === "string") return c;
      return c.display_name || c.name ||
        `${c.firstname || ""} ${c.lastname || ""}`.trim();
    }).filter(Boolean);

    const allLeads = [];
    const orgResults = [];

    for (let i = 0; i < organizations.length; i++) {
      const org = organizations[i];
      const orgName = org.organization_name || org.name || "";

      try {
        const leads = await discoverLeadsForOrg(org, apiKey);

        // Dedup against existing contacts
        const annotated = leads.map((lead) => ({
          ...lead,
          existing_contact: isExistingContact(lead.full_name || "", existingNames),
        }));

        const netNew = annotated.filter((l) => !l.existing_contact);
        const existing = annotated.filter((l) => l.existing_contact);

        allLeads.push(...annotated);
        orgResults.push({
          organization: orgName,
          leads_found: leads.length,
          net_new: netNew.length,
          existing_matches: existing.length,
        });
      } catch (err) {
        orgResults.push({
          organization: orgName,
          leads_found: 0,
          net_new: 0,
          existing_matches: 0,
          error: err.message,
        });
      }

      // Rate limit between orgs
      if (i < organizations.length - 1) await sleep(2000);
    }

    const netNewLeads = allLeads.filter((l) => !l.existing_contact);
    const totalFound = allLeads.length;

    res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({
      summary: {
        organizations_searched: organizations.length,
        total_leads_found: totalFound,
        net_new_leads: netNewLeads.length,
        existing_contact_matches: totalFound - netNewLeads.length,
      },
      org_results: orgResults,
      leads: allLeads,
      net_new_leads: netNewLeads,
    }));
  } catch (err) {
    console.error("Discover leads error:", err);
    res.writeHead(500, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Internal error" }));
  }
}
