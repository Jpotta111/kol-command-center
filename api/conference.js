/**
 * Vercel serverless function: Conference Intelligence.
 *
 * POST /api/conference
 * Headers: X-Gemini-Key
 * Body: {
 *   conference_name, conference_url, conference_dates, year,
 *   virta_presenters: [{ name, abstract_title, abstract_keywords }],
 *   existing_kols: [{ display_name, kol_tier, sme_owner, institution }]
 * }
 *
 * Uses Gemini 2.5 Flash with Google Search grounding to:
 *   1. Find conference sessions relevant to Virta's therapeutic area
 *   2. Identify presenters adjacent to a Virta team member's abstract
 *   3. Cross-reference with the existing KOL list
 *   4. Generate a team briefing AND a personal briefing for the
 *      Virta presenter — who should they connect with on-site?
 *
 * Virta presenters are flagged virta_internal and excluded from outreach.
 */

const GEMINI_MODEL = "gemini-2.5-flash";

// ── Fuzzy name matching ────────────────────────────────────────────────

function normalizeNameTokens(name) {
  return (name || "").toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean);
}

function nameSimilarity(a, b) {
  const ta = normalizeNameTokens(a);
  const tb = normalizeNameTokens(b);
  if (!ta.length || !tb.length) return 0;
  let matches = 0;
  for (const t of ta) if (tb.includes(t)) matches++;
  return matches / Math.max(ta.length, tb.length);
}

function findExistingKol(name, existingKols) {
  for (const k of existingKols) {
    const candidate = k.display_name || k.name || "";
    if (nameSimilarity(name, candidate) > 0.7) return k;
  }
  return null;
}

function isVirtaPresenter(name, virtaPresenters) {
  for (const p of virtaPresenters) {
    if (nameSimilarity(name, p.name || "") > 0.6) return true;
  }
  return false;
}

// ── Conference focus weighting ─────────────────────────────────────────

function buildFocusGuidance(conferenceName) {
  const isIspor = /ispor/i.test(conferenceName || "");
  if (isIspor) {
    return `This is an ISPOR conference — the leading society for health economics
and outcomes research. Weight HEOR heavily: real-world evidence, cost-
effectiveness analysis, budget impact modeling, claims data analysis,
payer/formulary decisions, propensity score methods, comparative
effectiveness, value-based care, QALYs, and patient-reported outcomes.
Virta's primary entry point at ISPOR is its outcomes research and
HEOR work in T2D / obesity / metabolic disease.`;
  }
  return `Weight clinical relevance to Virta's therapeutic area: type 2 diabetes,
obesity, metabolic disease, MASLD/NAFLD, cardiovascular comorbidities,
ketogenic and carbohydrate-restricted nutrition, telehealth-delivered
care, diabetes remission/reversal.`;
}

// ── Gemini conference scan ─────────────────────────────────────────────

async function scanConference({
  conferenceName, conferenceUrl, conferenceDates, year,
  virtaPresenters, existingKols, apiKey,
}) {
  const focusGuidance = buildFocusGuidance(conferenceName);

  const presenterContext = virtaPresenters.map((p, i) =>
    `${i + 1}. ${p.name} — "${p.abstract_title}"
   Methods/topics: ${(p.abstract_keywords || []).join(", ")}`
  ).join("\n");

  const existingKolList = existingKols.slice(0, 100).map((k) => {
    const name = k.display_name || k.name || "";
    const tier = k.kol_tier || k["MA_OPS Tier"] || "?";
    const owner = k.sme_owner || k["SME Owner"] || "";
    const inst = k.institution || k.company || "";
    return `- ${name} (Tier ${tier}${owner ? `, SME: ${owner}` : ""}${inst ? `, ${inst}` : ""})`;
  }).join("\n");

  const prompt = `You are scanning a medical/health-economics conference to find sessions
and presenters relevant to Virta Health, a virtual nutrition-therapy clinic
for type 2 diabetes reversal.

CONFERENCE: ${conferenceName}
URL: ${conferenceUrl}
DATES: ${conferenceDates}

FOCUS AREA:
${focusGuidance}

VIRTA TEAM PRESENTERS AT THIS CONFERENCE:
${presenterContext}

EXISTING VIRTA KOLs (cross-reference any matches):
${existingKolList || "(none provided)"}

YOUR TASK:
Use Google Search to investigate the conference program and find sessions and
presenters that are highly relevant to Virta. Search the conference URL above
plus general web for the program/agenda. Focus on:

1. Sessions related to the Virta presenter abstract(s) above (same disease area,
   same methods, same intervention modality)
2. Sessions on T2D, obesity, MASLD, metabolic disease outcomes
3. Sessions on telehealth / digital health interventions
4. Sessions on real-world evidence, propensity score matching, survival analysis,
   comparative effectiveness research in metabolic disease
5. Sessions on cost-effectiveness, budget impact, payer/formulary decisions
   for diabetes/obesity treatments (especially relevant for ISPOR)
6. Any presenter whose name matches an Existing Virta KOL above

Use search queries like:
- "${conferenceName} ${year} program sessions agenda"
- "${conferenceName} ${year} diabetes obesity real world evidence"
- "${conferenceName} ${year} telehealth nutrition outcomes"
- "${conferenceName} ${year} propensity score comparative effectiveness diabetes"
- "${conferenceName} ${year} cost effectiveness GLP-1 obesity"
- "${conferenceName} ${year} budget impact diabetes lifestyle intervention"
${virtaPresenters.map((p) =>
  `- "${conferenceName} ${year} ${(p.abstract_keywords || []).slice(0, 3).join(" ")}"`
).join("\n")}

RETURN AT LEAST 8 PRESENTERS if you can confirm them via search — but ONLY
include real people / real sessions you can confirm. Do not fabricate.

For each presenter, classify their relationship_type:
- "virta_internal" if their name matches a Virta team presenter listed above
- "existing_kol" if their name matches an Existing Virta KOL above
- "net_new" otherwise

Respond with ONLY a JSON object (no markdown fences, no prose). The "presenters"
array IS the canonical list — every relevant session you find must appear here
as a presenter entry. Keep each field SHORT (one or two sentences max). Do not
truncate the array — a leaner entry is better than a missing entry.

{
  "presenters": [
    {
      "full_name": "First Last",
      "institution": "institution",
      "session_title": "session/abstract title",
      "session_date_time": "date+time if known, else empty",
      "session_track": "track name",
      "relevance_to_virta": "ONE sentence: why it matters to Virta",
      "adjacency_to_team_abstract": "ONE sentence on overlap with the Virta presenter abstract, or empty string",
      "relationship_type": "virta_internal | existing_kol | net_new",
      "recommended_action": "meet at conference | reach out pre-conference | add to KOL list | monitor",
      "conversation_opener": "ONE sentence opener referencing the Virta presenter abstract",
      "source_url": "url"
    }
  ]
}

If you cannot find any relevant sessions via search, return {"presenters": []}.
Do not invent content.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192,
      },
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Gemini ${resp.status}: ${err?.error?.message || resp.statusText}`);
  }

  const data = await resp.json();
  let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  // Strip markdown fences if present (search-grounded responses often include them)
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Try to recover the JSON object
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch { parsed = null; }
    }
  }

  if (!parsed) {
    return {
      presenters: [], top_sessions: [],
      summary: { total_relevant_sessions: 0, existing_kols_presenting: 0,
        net_new_prospects: 0, virta_presenters_found: 0 },
      grounding: data?.candidates?.[0]?.groundingMetadata || null,
      raw_text: text,
    };
  }

  return {
    ...parsed,
    grounding: data?.candidates?.[0]?.groundingMetadata || null,
  };
}

// ── Briefing assembly ──────────────────────────────────────────────────

function deriveTopSessions(presenters, n = 5) {
  // Rank: existing_kol > adjacency > recommended-action priority > net_new
  const actionRank = {
    "meet at conference": 4,
    "reach out pre-conference": 3,
    "add to KOL list": 2,
    "monitor": 1,
  };
  const score = (p) => {
    let s = 0;
    if (p.relationship_type === "existing_kol") s += 5;
    if (p.adjacency_to_team_abstract && p.adjacency_to_team_abstract.trim()) s += 3;
    s += (actionRank[(p.recommended_action || "").toLowerCase()] || 0);
    return s;
  };
  return [...presenters]
    .filter((p) => p.relationship_type !== "virta_internal")
    .sort((a, b) => score(b) - score(a))
    .slice(0, n)
    .map((p) => ({
      session_title: p.session_title || "",
      session_date_time: p.session_date_time || "",
      session_track: p.session_track || "",
      lead_presenter: p.full_name || "",
      why_attend: p.relevance_to_virta || p.adjacency_to_team_abstract || "",
    }));
}

function buildTeamBriefing(presenters, virtaPresenters) {
  const existingKols = presenters.filter((p) => p.relationship_type === "existing_kol");
  const netNew = presenters.filter((p) => p.relationship_type === "net_new");
  const virtaPres = presenters.filter((p) => p.relationship_type === "virta_internal");
  const topSessions = deriveTopSessions(presenters, 5);

  // Top 3 priority contacts for meeting requests
  const priority = [...existingKols, ...netNew]
    .filter((p) => p.recommended_action === "reach out pre-conference" ||
                   p.recommended_action === "meet at conference")
    .slice(0, 3);

  const meetingRequests = priority.map((p) => ({
    to_name: p.full_name,
    institution: p.institution,
    subject_line: `Brief connection at ${getConferenceShortName(virtaPresenters)} — Virta Health`,
    body:
`Hi ${(p.full_name || "").split(" ")[0] || "there"},

I noticed you'll be presenting "${p.session_title || "[session]"}" at the upcoming meeting. ${p.adjacency_to_team_abstract || p.relevance_to_virta || ""}

A Virta colleague is also presenting (${(virtaPresenters[0] || {}).name || "our team"} on "${(virtaPresenters[0] || {}).abstract_title || "metabolic outcomes in T2D"}"). Would you have 15 minutes during the conference to compare notes? Happy to come to your booth or grab a coffee between sessions.

Best,
Jared Potter
Medical Affairs, Virta Health`,
  }));

  return {
    top_sessions: topSessions || [],
    existing_kols_presenting: existingKols,
    net_new_prospects: netNew,
    virta_presenters_at_conference: virtaPres,
    meeting_requests: meetingRequests,
  };
}

function getConferenceShortName(virtaPresenters) {
  // No conference name passed here; just a generic fallback
  return "the conference";
}

function buildPersonalBriefing(presenters, virtaPresenter) {
  if (!virtaPresenter) return null;

  // Adjacent = explicitly linked to the presenter's abstract
  const adjacent = presenters.filter((p) =>
    p.relationship_type !== "virta_internal" &&
    p.adjacency_to_team_abstract && p.adjacency_to_team_abstract.trim().length > 0
  );

  const keywords = (virtaPresenter.abstract_keywords || []).map((k) => k.toLowerCase());
  const methodTerms = ["propensity", "survival", "comparative effectiveness", "real world", "real-world", "rwe"];
  const telehealthTerms = ["telehealth", "digital health", "remote", "virtual care", "nutrition therapy"];

  function matchesAny(p, terms) {
    const haystack = [
      p.session_title, p.abstract_summary, p.session_track,
    ].filter(Boolean).join(" ").toLowerCase();
    return terms.some((t) => haystack.includes(t));
  }

  const methodMatches = presenters.filter((p) =>
    p.relationship_type !== "virta_internal" && matchesAny(p, methodTerms)
  );

  const telehealthMatches = presenters.filter((p) =>
    p.relationship_type !== "virta_internal" && matchesAny(p, telehealthTerms)
  );

  const existingKolMeetups = presenters.filter((p) => p.relationship_type === "existing_kol");

  return {
    presenter: virtaPresenter,
    adjacent_sessions: adjacent,
    method_matches: methodMatches,
    telehealth_sessions: telehealthMatches,
    existing_kol_meetups: existingKolMeetups,
  };
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

    const conferenceName = body.conference_name || "";
    const conferenceUrl = body.conference_url || "";
    const conferenceDates = body.conference_dates || "";
    const year = body.year || new Date().getFullYear();
    const virtaPresenters = Array.isArray(body.virta_presenters) ? body.virta_presenters : [];
    const existingKols = Array.isArray(body.existing_kols) ? body.existing_kols : [];

    if (!conferenceName) {
      res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "conference_name is required." })); return;
    }

    const scan = await scanConference({
      conferenceName, conferenceUrl, conferenceDates, year,
      virtaPresenters, existingKols, apiKey,
    });

    let presenters = Array.isArray(scan.presenters) ? scan.presenters : [];

    // Server-side reclassification: do not trust the model alone for the
    // outreach gate. Re-run name matching against the canonical lists.
    presenters = presenters.map((p) => {
      const name = p.full_name || "";
      if (isVirtaPresenter(name, virtaPresenters)) {
        return { ...p, relationship_type: "virta_internal", recommended_action: "n/a — Virta team" };
      }
      const existing = findExistingKol(name, existingKols);
      if (existing) {
        return {
          ...p,
          relationship_type: "existing_kol",
          existing_kol_tier: p.existing_kol_tier || existing.kol_tier || existing["MA_OPS Tier"] || "",
          existing_kol_sme_owner: p.existing_kol_sme_owner || existing.sme_owner || existing["SME Owner"] || "",
        };
      }
      return { ...p, relationship_type: "net_new" };
    });

    // Build briefings — virta_internal contacts are excluded from outreach
    const teamBriefing = buildTeamBriefing(presenters, virtaPresenters);
    const personalBriefing = buildPersonalBriefing(presenters, virtaPresenters[0]);

    const summary = {
      total_relevant_sessions: presenters.length,
      existing_kols_presenting: presenters.filter((p) => p.relationship_type === "existing_kol").length,
      net_new_prospects: presenters.filter((p) => p.relationship_type === "net_new").length,
      virta_presenters_found: presenters.filter((p) => p.relationship_type === "virta_internal").length,
      conference_name: conferenceName,
      conference_dates: conferenceDates,
    };

    res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({
      summary,
      presenters,
      team_briefing: teamBriefing,
      personal_briefing: personalBriefing,
      grounding: scan.grounding || null,
    }));
  } catch (err) {
    console.error("Conference error:", err);
    res.writeHead(500, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Internal error" }));
  }
}
