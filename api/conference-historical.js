/**
 * Vercel serverless function: Historical Conference Abstract Mining.
 *
 * POST /api/conference-historical
 * Headers: X-Gemini-Key
 * Body: {
 *   conference_name: "ISPOR",
 *   years: [2022, 2023, 2024, 2025, 2026],
 *   topic_keywords: [...],
 *   team_abstract_title: "...",
 *   team_abstract_keywords: [...],
 *   team_presenter_name: "..."  // for filtering out from outreach
 * }
 *
 * Mines past N years of conference abstracts via Gemini 2.5 Flash with
 * Google Search grounding. Identifies recurring presenters who are
 * relevant to the team presenter's abstract topic. Cross-references
 * with the current year program. Scores each person 1-10 by recency,
 * topic consistency, and current-year presence.
 *
 * Output is a flat presenter list ready for CSV export.
 */

const GEMINI_MODEL = "gemini-2.5-flash";

// ── Name matching for dedup ────────────────────────────────────────────

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

function isSamePerson(a, b) {
  return nameSimilarity(a, b) >= 0.7;
}

// ── Priority scoring ───────────────────────────────────────────────────

function computePriorityScore(p, currentYear) {
  const years = p.years_at_conference || [];
  const presentingNow = !!p.presenting_current_year;
  const yearCount = years.length;
  const recentYears = years.filter((y) => y >= currentYear - 2).length;
  const relevance = (p.relevance_to_team_abstract || "").toLowerCase();

  const directMatch =
    /direct match|direct/.test(relevance) ||
    /telehealth.*nutrition|propensity.*rwe|t2d.*obesity prevention/.test(relevance);
  const strongMatch =
    /strong match|strong/.test(relevance) ||
    /rwe.*t2d|digital health|nutrition.*cost/.test(relevance);

  // Base on years presented
  let score = Math.min(4, yearCount); // 1-4 baseline
  // Recency weight
  score += Math.min(2, recentYears);   // +0-2 for recent activity
  // Current year presence is a big multiplier
  if (presentingNow) score += 3;
  // Topic relevance
  if (directMatch) score += 2;
  else if (strongMatch) score += 1;
  // Cap at 10
  return Math.max(1, Math.min(10, score));
}

function recommendAction(p) {
  const yearCount = (p.years_at_conference || []).length;
  if (p.presenting_current_year && yearCount >= 2) return "meet at conference";
  if (p.presenting_current_year) return "reach out pre-conference";
  if (yearCount >= 2) return "add to KOL list";
  return "monitor";
}

// ── Gemini historical mining ───────────────────────────────────────────

async function mineHistoricalAbstracts({
  conferenceName, years, topicKeywords, teamAbstractTitle,
  teamAbstractKeywords, currentYear, apiKey,
}) {
  const sortedYears = [...years].sort((a, b) => a - b);
  const historicalYears = sortedYears.filter((y) => y < currentYear);
  const conf = conferenceName || "the conference";

  const topicHints = (topicKeywords || []).join(", ");
  const abstractKeywords = (teamAbstractKeywords || []).join(", ");

  const prompt = `Use Google Search to mine the historical abstract archive of
${conf} across these years: ${historicalYears.join(", ")}, AND scan the
${currentYear} program. Build a deduplicated list of recurring presenters
relevant to this Virta Health team abstract:

  TEAM ABSTRACT: "${teamAbstractTitle}"
  KEY METHODS / TOPICS: ${abstractKeywords}

TOPIC FILTER — only include presenters whose work touches:
${topicHints || "diabetes, obesity, telehealth, nutrition, real-world evidence, cost-effectiveness, propensity score, survival analysis"}

SEARCH STRATEGY (use Google Search via the tool):
For each historical year (${historicalYears.join(", ")}):
  - "${conf} {year} abstracts diabetes obesity real world evidence"
  - "${conf} {year} telehealth nutrition outcomes"
  - "${conf} {year} cost effectiveness diabetes GLP-1 lifestyle"
  - "${conf} {year} propensity score matching diabetes obesity"
  - "${conf} {year} health economics diabetes remission"
  - "site:ispor.org {year} abstract diabetes obesity" (if conference is ISPOR)
  - "ispor.org/heor-resources/presentations-database {year} diabetes" (if ISPOR)

For ${currentYear}:
  - Conference program/agenda for ${conf} ${currentYear}
  - "${conf} ${currentYear} diabetes obesity sessions speakers"

DEDUPLICATION:
After mining, identify presenters who appear across multiple years.
For each unique person, list ALL years they presented relevant work at
${conf} (e.g., [2023, 2024, 2025]). Cross-reference with ${currentYear}:
mark presenting_current_year=true if they have a confirmed ${currentYear} session.

RELEVANCE CLASSIFICATION (for relevance_to_team_abstract field):
- "direct match" — telehealth nutrition programs, T2D obesity prevention,
  propensity score RWE in metabolic disease
- "strong match" — RWE methods in T2D, digital health outcomes,
  nutrition intervention cost-effectiveness
- "adjacent" — GLP-1 RWE comparisons, obesity treatment economics,
  diabetes HEOR broadly

Return AT LEAST 10 unique people if findable. Only include real people
confirmed via search — do not fabricate. Keep each field SHORT.

Respond with ONLY a JSON object (no markdown, no prose):
{
  "presenters": [
    {
      "full_name": "First Last",
      "affiliation": "institution / employer",
      "linkedin_url": "url if found, else empty",
      "years_at_conference": [2023, 2024, 2025],
      "presenting_current_year": true,
      "current_year_session_title": "session title if presenting ${currentYear}, else empty",
      "current_year_session_datetime": "date+time if known, else empty",
      "topic_area": "short label, e.g. T2D HEOR / RWE / Telehealth",
      "relevance_to_team_abstract": "direct match | strong match | adjacent — followed by ONE sentence why",
      "notes": "ONE sentence with anything noteworthy (recurring methods, key collaborator, etc.)",
      "source_url": "url where confirmed"
    }
  ]
}`;

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
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch { parsed = null; }
    }
  }

  return {
    presenters: parsed?.presenters || [],
    grounding: data?.candidates?.[0]?.groundingMetadata || null,
    raw_text: parsed ? null : text.slice(0, 500),
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
    const years = Array.isArray(body.years) ? body.years.filter((y) => Number.isFinite(+y)).map((y) => +y) : [];
    const topicKeywords = Array.isArray(body.topic_keywords) ? body.topic_keywords : [];
    const teamAbstractTitle = body.team_abstract_title || "";
    const teamAbstractKeywords = Array.isArray(body.team_abstract_keywords) ? body.team_abstract_keywords : [];
    const teamPresenterName = body.team_presenter_name || "";

    if (!conferenceName || !years.length) {
      res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "conference_name and years are required." })); return;
    }

    const currentYear = Math.max(...years);

    const mined = await mineHistoricalAbstracts({
      conferenceName, years, topicKeywords, teamAbstractTitle,
      teamAbstractKeywords, currentYear, apiKey,
    });

    // Dedupe + post-process
    const dedup = [];
    for (const raw of mined.presenters) {
      const name = raw.full_name || "";
      if (!name) continue;
      // Filter out the team presenter — they shouldn't appear in their own outreach list.
      if (teamPresenterName && isSamePerson(name, teamPresenterName)) continue;
      // Find existing entry with similar name and merge
      const existing = dedup.find((d) => isSamePerson(d.full_name, name));
      if (existing) {
        const merged = new Set([
          ...(existing.years_at_conference || []),
          ...(raw.years_at_conference || []),
        ]);
        existing.years_at_conference = [...merged].sort((a, b) => a - b);
        existing.presenting_current_year = existing.presenting_current_year || !!raw.presenting_current_year;
        if (!existing.linkedin_url && raw.linkedin_url) existing.linkedin_url = raw.linkedin_url;
        if (!existing.affiliation && raw.affiliation) existing.affiliation = raw.affiliation;
        if (raw.current_year_session_title && !existing.current_year_session_title) {
          existing.current_year_session_title = raw.current_year_session_title;
          existing.current_year_session_datetime = raw.current_year_session_datetime || "";
        }
      } else {
        dedup.push({
          full_name: name,
          affiliation: raw.affiliation || "",
          linkedin_url: raw.linkedin_url || "",
          years_at_conference: Array.isArray(raw.years_at_conference)
            ? [...new Set(raw.years_at_conference.map((y) => +y).filter(Number.isFinite))].sort((a, b) => a - b)
            : [],
          presenting_current_year: !!raw.presenting_current_year,
          current_year_session_title: raw.current_year_session_title || "",
          current_year_session_datetime: raw.current_year_session_datetime || "",
          topic_area: raw.topic_area || "",
          relevance_to_team_abstract: raw.relevance_to_team_abstract || "",
          notes: raw.notes || "",
          source_url: raw.source_url || "",
        });
      }
    }

    // Score and sort
    const scored = dedup.map((p) => {
      const priority_score = computePriorityScore(p, currentYear);
      const recommended_action = recommendAction(p);
      return { ...p, priority_score, recommended_action };
    }).sort((a, b) => b.priority_score - a.priority_score);

    const summary = {
      conference_name: conferenceName,
      years_searched: years,
      current_year: currentYear,
      unique_presenters: scored.length,
      recurring_presenters_2plus: scored.filter((p) => (p.years_at_conference || []).length >= 2).length,
      regulars_3plus: scored.filter((p) => (p.years_at_conference || []).length >= 3).length,
      presenting_current_year: scored.filter((p) => p.presenting_current_year).length,
    };

    res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({
      summary,
      presenters: scored,
      grounding: mined.grounding,
      ...(mined.raw_text ? { raw_text_sample: mined.raw_text } : {}),
    }));
  } catch (err) {
    console.error("Conference-historical error:", err);
    res.writeHead(500, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Internal error" }));
  }
}
