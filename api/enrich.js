/**
 * Vercel serverless function: CSV enrichment via OpenAlex + PubMed.
 *
 * POST /api/enrich  (multipart/form-data with a "file" field)
 *
 * OPS scoring redesigned for Medical Affairs priorities:
 *   1. Institutional Credibility (0-20)
 *   2. Clinical Relevance via PubMed (0-20)
 *   3. Collaboration Signal (0-20)
 *   4. Nutrition/Lifestyle Openness (0-20)
 *   5. Strategic Reach (0-20)
 */

import { Readable } from "stream";

// ── Config ─────────────────────────────────────────────────────────────

const CONFIG = {
  nutrition_keywords: [
    "low carbohydrate", "low-carbohydrate", "ketogenic",
    "carbohydrate restriction", "dietary intervention",
    "nutritional ketosis", "very low calorie", "caloric restriction",
  ],
  tier_thresholds: { A: 80, B: 60, C: 40 },
};

const OPENALEX_BASE = "https://api.openalex.org";
const PUBMED_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

// ── Institutional tiers ────────────────────────────────────────────────

const TOP_AMC_KEYWORDS = [
  "johns hopkins", "mayo clinic", "harvard medical", "harvard t.h. chan",
  "brigham and women", "massachusetts general", "ucsf",
  "stanford medicine", "stanford university", "yale medicine",
  "yale university", "columbia university", "penn medicine",
  "university of pennsylvania", "vanderbilt", "duke university",
  "duke health", "cleveland clinic", "mount sinai", "nyu langone",
  "university of michigan", "michigan medicine", "university of chicago",
  "northwestern university", "northwestern medicine", "emory university",
  "university of pittsburgh", "upmc", "university of washington",
  "washington university in st. louis", "baylor college", "uc san diego",
  "scripps research", "scripps institution", "md anderson",
  "memorial sloan", "dana-farber", "cedars-sinai",
  "university of virginia", "unc chapel hill", "university of north carolina",
  "oregon health", "university of colorado", "tufts university",
  "tufts medical", "boston university", "ut southwestern",
  "university of florida", "university of wisconsin", "weill cornell",
  "albert einstein college", "university of california",
  "karolinska", "oxford university", "university of cambridge",
];

const MAJOR_SYSTEM_KEYWORDS = [
  "university hospital", "university medical", "medical school",
  "school of medicine", "college of medicine", "medical college",
  "teaching hospital", "academic medical", "health science",
  "national institutes of health", "nih", "cdc",
  "centers for disease", "veterans affairs", "va medical",
];

function isTopAMC(institution) {
  if (!institution) return false;
  const lower = institution.toLowerCase();
  return TOP_AMC_KEYWORDS.some((kw) => lower.includes(kw));
}

function isMajorSystem(institution) {
  if (!institution) return false;
  const lower = institution.toLowerCase();
  return MAJOR_SYSTEM_KEYWORDS.some((kw) => lower.includes(kw));
}

// ── OPS Dimension 1: Institutional Credibility (0-20) ──────────────────

function scoreInstitutionalCredibility(author) {
  const inst = author.institution || "";
  if (isTopAMC(inst)) {
    // Scale within 16-20 based on h-index as tiebreaker
    const h = author.h_index || 0;
    const bonus = Math.min(4, Math.floor(h / 25));
    return clamp(16 + bonus);
  }
  if (isMajorSystem(inst)) {
    return clamp(13);
  }
  if (inst) {
    // Some institution listed — regional/community
    return clamp(7);
  }
  return clamp(3); // Unknown / private practice
}

// ── OPS Dimension 2: Clinical Relevance via PubMed (0-20) ──────────────
// Weighted multi-tier: primary MeSH (1.0), secondary MeSH (0.7), text words (0.5)

const MESH_PRIMARY = [
  { term: "Diabetes Mellitus, Type 2", weight: 1.0 },
  { term: "Diet, Ketogenic", weight: 1.0 },
  { term: "Diet, Carbohydrate-Restricted", weight: 1.0 },
  { term: "Insulin Resistance", weight: 1.0 },
  { term: "Glycated Hemoglobin", weight: 1.0 },
  { term: "Hypoglycemic Agents", weight: 1.0 },
];

const MESH_SECONDARY = [
  { term: "Obesity", weight: 0.7 },
  { term: "Weight Loss", weight: 0.7 },
  { term: "Dyslipidemias", weight: 0.7 },
  { term: "Triglycerides", weight: 0.7 },
  { term: "Hypertension", weight: 0.7 },
  { term: "C-Reactive Protein", weight: 0.7 },
  { term: "Cardiovascular Diseases", weight: 0.7 },
  { term: "Metabolic Syndrome", weight: 0.7 },
  { term: "Telemedicine", weight: 0.7 },
];

const TEXT_WORDS = [
  { term: "nutritional ketosis", weight: 0.5 },
  { term: "carbohydrate restriction", weight: 0.5 },
  { term: "low carbohydrate", weight: 0.5 },
  { term: "continuous care", weight: 0.5 },
  { term: "diabetes reversal", weight: 0.5 },
  { term: "diabetes remission", weight: 0.5 },
];

async function pubmedCount(query) {
  const params = new URLSearchParams({
    db: "pubmed", term: query, rettype: "count", retmode: "json",
  });
  const resp = await fetch(`${PUBMED_BASE}/esearch.fcgi?${params}`);
  if (!resp.ok) throw new Error(`PubMed ${resp.status}`);
  const data = await resp.json();
  return parseInt(data?.esearchresult?.count || "0", 10);
}

async function scoreClinicalRelevance(author) {
  const name = author.display_name || "";
  if (!name) return 10;

  try {
    const totalCount = await pubmedCount(`${name}[Author]`);
    if (totalCount === 0) return fallbackClinicalRelevance(author);

    const cappedTotal = Math.min(totalCount, 500);

    // Primary MeSH: hit ratio * weight 1.0, scaled to 10 points max
    const primaryQuery = MESH_PRIMARY.map((t) => `"${t.term}"[MeSH]`).join(" OR ");
    const primaryCount = await pubmedCount(`${name}[Author] AND (${primaryQuery})`);
    const primaryRatio = primaryCount / cappedTotal;
    await new Promise((r) => setTimeout(r, 400));

    // Secondary MeSH: hit ratio * weight 0.7, scaled to 6 points max
    const secondaryQuery = MESH_SECONDARY.map((t) => `"${t.term}"[MeSH]`).join(" OR ");
    const secondaryCount = await pubmedCount(`${name}[Author] AND (${secondaryQuery})`);
    const secondaryRatio = secondaryCount / cappedTotal;
    await new Promise((r) => setTimeout(r, 400));

    // Text words (TIAB): hit ratio * weight 0.5, scaled to 4 points max
    const textQuery = TEXT_WORDS.map((t) => `"${t.term}"[TIAB]`).join(" OR ");
    const textCount = await pubmedCount(`${name}[Author] AND (${textQuery})`);
    const textRatio = textCount / cappedTotal;

    // Score: each tier contributes proportionally
    // Primary up to 8 pts, secondary up to 4, text words up to 8 = 20 max
    // Text words weighted heavily because they catch Virta-specific language
    // (nutritional ketosis, carbohydrate restriction, diabetes remission)
    const score = (primaryRatio * 8) + (secondaryRatio * 4) + (textRatio * 8);
    return clamp(Math.round(score * 100) / 100);
  } catch {
    return fallbackClinicalRelevance(author);
  }
}

function fallbackClinicalRelevance(author) {
  // Fallback: OpenAlex concept matching with same term set
  const targets = [
    ...MESH_PRIMARY.map((t) => ({ label: t.term.toLowerCase(), weight: t.weight })),
    ...MESH_SECONDARY.map((t) => ({ label: t.term.toLowerCase(), weight: t.weight })),
  ];

  const conceptText = (author.concepts || [])
    .map((c) => (typeof c === "object" ? c.display_name || "" : String(c)))
    .join(" ")
    .toLowerCase();

  let matchedW = 0, totalW = 0;
  for (const tc of targets) {
    totalW += tc.weight;
    if (conceptText.includes(tc.label)) matchedW += tc.weight;
  }
  if (totalW === 0) return 10;
  return clamp(Math.round((matchedW / totalW) * 20 * 100) / 100);
}

// ── OPS Dimension 3: Collaboration Signal (0-20) ──────────────────────

function scoreCollaborationSignal(author, contact) {
  // Check "Virta Paper CoAuthor" from CSV
  const coauthorFlag = (
    contact["Virta Paper CoAuthor"] ||
    contact["virta_paper_coauthor"] ||
    contact["Virta Paper Coauthor"] ||
    ""
  ).toLowerCase();

  if (coauthorFlag === "true" || coauthorFlag === "yes" || coauthorFlag === "1") {
    return { score: 20, reason: "Virta Paper CoAuthor" };
  }

  const h = author.h_index || 0;
  const inst = author.institution || "";

  if (h > 30 && isTopAMC(inst)) {
    return { score: 14, reason: "Top AMC + high h-index" };
  }

  // Pharma payments signal = industry engagement = collaborative tendency
  // We don't have pharma data in browser enrichment, so check if we
  // have any signals from the CSV or use neutral
  const pharmaFlag = contact["Open Payments"] || contact["open_payments"] || "";
  if (pharmaFlag && pharmaFlag !== "0" && pharmaFlag.toLowerCase() !== "false") {
    return { score: 10, reason: "Industry engaged (Open Payments)" };
  }

  return { score: 8, reason: "No signals detected" };
}

// ── OPS Dimension 4: Nutrition/Lifestyle Openness (0-20) ───────────────

function scoreNutritionOpenness(author, collaborationScore) {
  const keywords = CONFIG.nutrition_keywords;
  if (!keywords.length) return 10;

  const textParts = [...(author.recent_work_titles || [])];
  for (const c of author.concepts || []) {
    textParts.push(typeof c === "object" ? c.display_name || "" : String(c));
  }
  const searchable = textParts.join(" ").toLowerCase();

  let matches = 0;
  for (const kw of keywords) {
    if (searchable.includes(kw.toLowerCase())) matches++;
  }

  let score = clamp(10 + matches * 2);

  // Co-authors are implicitly open enough — floor at 12
  if (collaborationScore === 20 && score < 12) {
    score = 12;
  }

  return score;
}

// ── OPS Dimension 5: Strategic Reach (0-20) ────────────────────────────

function scoreStrategicReach(author) {
  let score = 0;
  const citations = author.citation_count || 0;
  const h = author.h_index || 0;
  const inst = author.institution || "";

  // Citation tiers
  if (citations > 10000) score += 8;
  else if (citations > 1000) score += 5;
  else if (citations > 100) score += 3;

  // h-index tiers
  if (h > 50) score += 4;
  else if (h >= 20) score += 2;

  // Top AMC bonus (intentional overlap with Dim 1)
  if (isTopAMC(inst)) score += 4;

  // Pharma entanglement not available in browser enrichment;
  // handled at pipeline level. Default neutral here.

  return clamp(Math.round(score * 100) / 100);
}

// ── Composite scorer ───────────────────────────────────────────────────

function clamp(v, lo = 0, hi = 20) {
  return Math.max(lo, Math.min(hi, v));
}

async function computeOPSScore(author, contact) {
  const instCred = scoreInstitutionalCredibility(author);
  const clinRel = await scoreClinicalRelevance(author);
  const collab = scoreCollaborationSignal(author, contact);
  const nutrOpen = scoreNutritionOpenness(author, collab.score);
  const stratReach = scoreStrategicReach(author);

  const composite = Math.round(
    (instCred + clinRel + collab.score + nutrOpen + stratReach) * 100
  ) / 100;

  const t = CONFIG.tier_thresholds;
  let tier = "D";
  if (composite >= t.A) tier = "A";
  else if (composite >= t.B) tier = "B";
  else if (composite >= t.C) tier = "C";

  return {
    ops_score: composite,
    tier,
    institutional_credibility_score: instCred,
    clinical_relevance_score: clinRel,
    collaboration_signal_score: collab.score,
    collaboration_reason: collab.reason,
    nutrition_openness_score: nutrOpen,
    strategic_reach_score: stratReach,
  };
}

// ── OpenAlex search ────────────────────────────────────────────────────

async function searchAuthor(name, institution, email) {
  const params = new URLSearchParams({
    search: name,
    per_page: "5",
    select: "id,display_name,orcid,last_known_institutions,summary_stats,cited_by_count,works_count,topics,x_concepts",
    mailto: email,
  });

  const resp = await fetch(`${OPENALEX_BASE}/authors?${params}`);
  if (!resp.ok) return null;

  const data = await resp.json();
  const results = data.results || [];
  if (!results.length) return null;

  const queryName = name.trim().toLowerCase();
  const queryInst = (institution || "").trim().toLowerCase();
  const queryTokens = new Set(queryName.split(/\s+/));

  let bestMatch = null;
  let bestScore = 0;

  for (const raw of results) {
    const candName = (raw.display_name || "").trim().toLowerCase();
    const candTokens = new Set(candName.split(/\s+/));
    if (!candTokens.size) continue;

    let overlap = 0;
    for (const t of queryTokens) {
      if (candTokens.has(t)) overlap++;
    }
    const nameScore = overlap / Math.max(queryTokens.size, candTokens.size);

    let instBoost = 0;
    if (queryInst) {
      for (const inst of raw.last_known_institutions || []) {
        const instName = (inst.display_name || "").toLowerCase();
        if (instName.includes(queryInst) || queryInst.includes(instName)) {
          instBoost = 0.2;
          break;
        }
      }
    }

    const confidence = Math.min(1.0, nameScore + instBoost);
    if (confidence > bestScore) {
      bestScore = confidence;
      bestMatch = raw;
    }
  }

  if (bestScore < 0.8 || !bestMatch) return null;
  return parseAuthor(bestMatch);
}

function parseAuthor(raw) {
  const lastKnown = raw.last_known_institutions || [];
  const institution = lastKnown.length ? lastKnown[0].display_name : null;
  const topics = raw.topics || raw.x_concepts || [];

  return {
    openalex_id: raw.id || "",
    display_name: raw.display_name || "",
    orcid: raw.orcid || null,
    institution,
    h_index: (raw.summary_stats || {}).h_index || 0,
    citation_count: raw.cited_by_count || 0,
    pub_count: raw.works_count || 0,
    concepts: topics.map((c) => ({
      id: c.id || "",
      display_name: c.display_name || "",
      score: c.score || 0,
    })),
    recent_work_titles: [],
  };
}

async function fetchRecentTitles(authorId, email) {
  const shortId = authorId.replace("https://openalex.org/", "");
  const params = new URLSearchParams({
    filter: `authorships.author.id:${shortId}`,
    per_page: "20",
    select: "id,title,publication_year",
    sort: "publication_year:desc",
    mailto: email,
  });

  try {
    const resp = await fetch(`${OPENALEX_BASE}/works?${params}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.results || []).map((w) => w.title).filter(Boolean);
  } catch {
    return [];
  }
}

// ── CSV parsing ────────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = (values[idx] || "").trim();
    });
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

function escapeCSVField(val) {
  const s = String(val ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ── Multipart form parser ──────────────────────────────────────────────

async function parseMultipart(req) {
  const contentType = req.headers["content-type"] || req.headers.get?.("content-type") || "";
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) throw new Error("No multipart boundary found");

  const boundary = boundaryMatch[1];
  const chunks = [];

  if (typeof req.arrayBuffer === "function") {
    const buf = Buffer.from(await req.arrayBuffer());
    chunks.push(buf);
  } else {
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
  }

  const body = Buffer.concat(chunks).toString("utf-8");
  const parts = body.split(`--${boundary}`);

  for (const part of parts) {
    if (part.includes('name="file"') || part.includes("filename=")) {
      const headerEnd = part.indexOf("\r\n\r\n");
      if (headerEnd === -1) continue;
      let content = part.slice(headerEnd + 4);
      if (content.endsWith("--\r\n")) content = content.slice(0, -4);
      else if (content.endsWith("\r\n")) content = content.slice(0, -2);
      return content;
    }
  }

  throw new Error("No file field found in multipart data");
}

// ── Main handler ───────────────────────────────────────────────────────

export default async function handler(req, res) {
  const origin = req.headers.origin || req.headers.get?.("origin") || "*";
  const corsHeaders = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-OpenAlex-Email, X-Gemini-Key",
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const email = req.headers["x-openalex-email"]
      || process.env.OPENALEX_EMAIL
      || "";

    const csvText = await parseMultipart(req);
    const contacts = parseCSV(csvText);

    if (!contacts.length) {
      res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No rows found in CSV" }));
      return;
    }

    const outputColumns = [
      "hs_object_id", "openalex_match_status", "existing_kol_tier",
      "ops_score", "kol_tier",
      "institutional_credibility_score", "clinical_relevance_score",
      "collaboration_signal_score", "collaboration_reason",
      "nutrition_openness_score", "strategic_reach_score",
      "openalex_id", "orcid", "top_paper_title", "top_paper_doi",
      "h_index", "citation_count", "institution",
      "nutrition_signal_keywords", "last_profiled_date",
      "nutrition_stance", "nutrition_stance_source",
    ];

    const enrichedRows = [];
    let matched = 0;
    let notFound = 0;

    for (const contact of contacts) {
      let name = contact.display_name || contact.Name || contact.name || "";
      if (!name) {
        const first = contact.firstname || contact["First Name"] || contact.first_name || "";
        const last = contact.lastname || contact["Last Name"] || contact.last_name || "";
        name = `${first} ${last}`.trim();
      }

      const institution =
        contact.institution || contact.Institution ||
        contact.company || contact.Company || "";
      const hsId = contact.hs_object_id || contact["Record ID"] || "";
      const existingTier = contact["MA_OPS Tier"] || contact["ma_ops_tier"] || "";

      if (!name) {
        enrichedRows.push(emptyRow(hsId, "skip_no_name", existingTier));
        notFound++;
        continue;
      }

      const author = await searchAuthor(name, institution, email);

      if (!author) {
        enrichedRows.push(emptyRow(hsId, "not_found", existingTier));
        notFound++;
        continue;
      }

      author.recent_work_titles = await fetchRecentTitles(author.openalex_id, email);

      const score = await computeOPSScore(author, contact);

      enrichedRows.push({
        hs_object_id: hsId,
        openalex_match_status: "matched",
        existing_kol_tier: existingTier,
        ops_score: score.ops_score,
        kol_tier: score.tier,
        institutional_credibility_score: score.institutional_credibility_score,
        clinical_relevance_score: score.clinical_relevance_score,
        collaboration_signal_score: score.collaboration_signal_score,
        collaboration_reason: score.collaboration_reason,
        nutrition_openness_score: score.nutrition_openness_score,
        strategic_reach_score: score.strategic_reach_score,
        openalex_id: author.openalex_id,
        orcid: author.orcid || "",
        top_paper_title: (author.recent_work_titles || [])[0] || "",
        top_paper_doi: "",
        h_index: author.h_index,
        citation_count: author.citation_count,
        institution: author.institution || "",
        nutrition_signal_keywords: "",
        last_profiled_date: new Date().toISOString().split("T")[0],
        nutrition_stance: "",
        nutrition_stance_source: "",
      });
      matched++;

      await new Promise((r) => setTimeout(r, 100));
    }

    const csvHeader = outputColumns.join(",");
    const csvRows = enrichedRows.map((row) =>
      outputColumns.map((col) => escapeCSVField(row[col])).join(",")
    );
    const csvOutput = [csvHeader, ...csvRows].join("\r\n");

    res.writeHead(200, {
      ...corsHeaders,
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="kol_enriched.csv"',
      "X-Enrichment-Matched": String(matched),
      "X-Enrichment-NotFound": String(notFound),
      "X-Enrichment-Total": String(contacts.length),
      "Access-Control-Expose-Headers":
        "X-Enrichment-Matched, X-Enrichment-NotFound, X-Enrichment-Total",
    });
    res.end(csvOutput);
  } catch (err) {
    console.error("Enrich error:", err);
    res.writeHead(500, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Internal error" }));
  }
}

function emptyRow(hsId, status, existingTier) {
  return {
    hs_object_id: hsId,
    openalex_match_status: status,
    existing_kol_tier: existingTier || "",
    ops_score: "", kol_tier: "",
    institutional_credibility_score: "", clinical_relevance_score: "",
    collaboration_signal_score: "", collaboration_reason: "",
    nutrition_openness_score: "", strategic_reach_score: "",
    openalex_id: "", orcid: "",
    top_paper_title: "", top_paper_doi: "", h_index: "",
    citation_count: "", institution: "", nutrition_signal_keywords: "",
    last_profiled_date: "", nutrition_stance: "", nutrition_stance_source: "",
  };
}
