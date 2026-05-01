/**
 * Vercel serverless function: MSL network expansion via Gemini + Google Search.
 *
 * POST /api/msl-enrich
 * Body: { contact: { name, email, title, organization } }
 * Headers: X-Gemini-Key
 *
 * For a single seed MSL contact:
 * 1. Confirms their current role and org
 * 2. Discovers professional colleagues and network connections
 * 3. Scores each net-new prospect on IPS (Influence Prioritization Score)
 *
 * Returns: { seed, prospects[] }
 */

const GEMINI_MODEL = "gemini-2.5-flash";

// ── IPS Scoring ───────────────────────────────────────────────────────

function scoreRoleSeniority(title) {
  const t = (title || "").toLowerCase();
  if (t.includes("chief medical") || t === "cmo" || t.includes("chief medical officer")) return 20;
  if ((t.includes("vp") || t.includes("vice president")) && (t.includes("medical") || t.includes("clinical"))) return 17;
  if (t.includes("medical director")) return 14;
  if (t.includes("director") && (t.includes("clinical") || t.includes("medical") || t.includes("health") || t.includes("pharmacy") || t.includes("formulary"))) return 10;
  if (t.includes("manager") || t.includes("coordinator")) return 5;
  return 7;
}

function scoreOrgScale(orgType) {
  const map = {
    "National Payer": 20,
    "Regional Payer": 16,
    "Health System": 14,
    "IDN": 10,
    "Other": 6,
  };
  return map[orgType] || 6;
}

function scoreStrategicRelevance(focus) {
  const map = {
    "metabolic": 20,
    "vbc": 16,
    "formulary": 14,
    "population_health": 10,
    "general": 6,
  };
  return map[focus] || 6;
}

function scoreConnectionStrength(connType) {
  const map = {
    "colleague": 20,
    "former_colleague": 14,
    "board": 14,
    "advisory": 12,
    "2nd_degree": 8,
    "3rd_degree": 4,
  };
  return map[connType] || 4;
}

function scoreEngagement(contact) {
  let score = 0;
  if (contact.published_recently) score += 6;
  if (contact.recent_news && contact.recent_news.length > 10) score += 4;
  if (contact.linkedin_url && contact.linkedin_url.length > 5) score += 2;
  return Math.min(20, score);
}

function computeIPS(prospect) {
  const seniority = scoreRoleSeniority(prospect.title);
  const orgScale = scoreOrgScale(prospect.org_type);
  const relevance = scoreStrategicRelevance(prospect.strategic_focus);
  const connection = scoreConnectionStrength(prospect.connection_type);
  const engagement = scoreEngagement(prospect);
  const total = seniority + orgScale + relevance + connection + engagement;
  const clamped = Math.min(100, total);
  return {
    ips_score: clamped,
    score_breakdown: {
      seniority,
      org_scale: orgScale,
      strategic_relevance: relevance,
      connection_strength: connection,
      engagement,
    },
    tier: clamped >= 75 ? "A" : clamped >= 55 ? "B" : clamped >= 40 ? "C" : "D",
  };
}

// ── Gemini enrichment ─────────────────────────────────────────────────

async function enrichSeedContact(contact, apiKey) {
  const name = contact.name || `${contact.first_name || ""} ${contact.last_name || ""}`.trim();
  const org = contact.organization || contact.company || "";
  const title = contact.title || contact.job_title || "";

  const prompt = `Search for information about ${name}${org ? ` at ${org}` : ""}${title ? `, ${title}` : ""}.

Your goal: confirm who this person is and find their professional colleagues who work in medical, clinical, or pharmacy leadership at payer organizations, health systems, or IDNs.

Find:
1. Their confirmed current role and employer
2. Organization type: National Payer (Aetna, UnitedHealth, BCBS, Cigna, Humana, CVS/Aetna, Elevance/Anthem), Regional Payer, Health System, IDN, or Other
3. Professional colleagues at their organization — Medical Directors, CMOs, Chief Clinical Officers, VPs of Medical Affairs, population health leaders, pharmacy directors, formulary committee members
4. Any professional connections at OTHER payer organizations (former employers, board memberships, advisory roles, speaking relationships)
5. Recent news about this person (last 12 months)

Return ONLY valid JSON with no markdown formatting:
{
  "confirmed_name": "full name",
  "confirmed_title": "current job title",
  "confirmed_org": "current employer",
  "org_type": "National Payer",
  "data_confidence": "HIGH",
  "recent_news": "one sentence summary or empty string",
  "linkedin_url": "URL or empty string",
  "colleagues": [
    {
      "full_name": "First Last",
      "title": "their exact title",
      "organization": "their employer",
      "connection_type": "colleague",
      "connection_detail": "brief description, e.g. both work in clinical programs at Aetna",
      "strategic_focus": "metabolic",
      "org_type": "National Payer",
      "published_recently": false,
      "recent_news": "one sentence or empty string",
      "linkedin_url": "URL or empty string",
      "source_url": "URL where this person was confirmed",
      "data_confidence": "HIGH"
    }
  ]
}

Valid values:
- org_type: "National Payer" | "Regional Payer" | "Health System" | "IDN" | "Other"
- connection_type: "colleague" | "former_colleague" | "board" | "advisory" | "2nd_degree"
- strategic_focus: "metabolic" | "vbc" | "formulary" | "population_health" | "general"
- data_confidence: "HIGH" | "MEDIUM" | "LOW"

Only include colleagues you can confirm via search. Do NOT invent people. If none found, return empty array.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.1,
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
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

  let result;
  try {
    result = JSON.parse(text.trim());
  } catch {
    result = { colleagues: [] };
  }

  return result;
}

// ── Main handler ──────────────────────────────────────────────────────

export default async function handler(req, res) {
  const origin = req.headers.origin || req.headers.get?.("origin") || "*";
  const corsHeaders = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Gemini-Key",
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
      res.end(JSON.stringify({ error: "Gemini API key required. Add it in Settings." })); return;
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

    const contact = body.contact;
    if (!contact) {
      res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No contact provided." })); return;
    }

    const name = contact.name || `${contact.first_name || ""} ${contact.last_name || ""}`.trim();
    const seedId = `seed_${name.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;

    const enriched = await enrichSeedContact(contact, apiKey);
    const today = new Date().toISOString().split("T")[0];

    // Score and annotate each discovered colleague
    const scoredProspects = (enriched.colleagues || []).map((c, i) => {
      const scoring = computeIPS(c);
      return {
        id: `${seedId}_p${i}`,
        full_name: c.full_name || "",
        title: c.title || "",
        organization: c.organization || enriched.confirmed_org || "",
        org_type: c.org_type || enriched.org_type || "Other",
        connection_type: c.connection_type || "colleague",
        connection_detail: c.connection_detail || "",
        seed_name: name,
        seed_id: seedId,
        strategic_focus: c.strategic_focus || "general",
        published_recently: c.published_recently || false,
        recent_news: c.recent_news || "",
        linkedin_url: c.linkedin_url || "",
        source_url: c.source_url || "",
        data_confidence: c.data_confidence || "LOW",
        status: "NET-NEW",
        discovered_date: today,
        ...scoring,
      };
    });

    const seed = {
      id: seedId,
      original_name: name,
      original_title: contact.title || contact.job_title || "",
      original_org: contact.organization || contact.company || "",
      original_email: contact.email || "",
      confirmed_name: enriched.confirmed_name || name,
      confirmed_title: enriched.confirmed_title || contact.title || contact.job_title || "",
      confirmed_org: enriched.confirmed_org || contact.organization || contact.company || "",
      org_type: enriched.org_type || "Other",
      data_confidence: enriched.data_confidence || "LOW",
      recent_news: enriched.recent_news || "",
      linkedin_url: enriched.linkedin_url || "",
      status: "SEED",
    };

    res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ seed, prospects: scoredProspects }));
  } catch (err) {
    console.error("MSL enrich error:", err);
    res.writeHead(500, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Internal error" }));
  }
}
