/**
 * Vercel serverless function: CSV enrichment via OpenAlex.
 *
 * POST /api/enrich  (multipart/form-data with a "file" field)
 *
 * For each row, searches OpenAlex by name + institution, computes a
 * simplified OPS score (no graph centrality), and returns an enriched
 * CSV as a download. No data is stored server-side.
 */

import { Readable } from "stream";

// ── Config (mirrors config/ops_config.json) ────────────────────────────

const CONFIG = {
  openalex_concepts: [
    { label: "Type 2 diabetes", weight: 1.0 },
    { label: "Obesity", weight: 0.9 },
    { label: "Metabolic syndrome", weight: 0.9 },
    { label: "Insulin resistance", weight: 0.8 },
    { label: "Dietary supplement", weight: 0.6 },
  ],
  nutrition_keywords: [
    "low carbohydrate", "low-carbohydrate", "ketogenic",
    "carbohydrate restriction", "dietary intervention",
    "nutritional ketosis", "very low calorie", "caloric restriction",
  ],
  tier_thresholds: { A: 80, B: 60, C: 40 },
};

const OPENALEX_BASE = "https://api.openalex.org";

// ── OPS scoring (simplified — no graph centrality) ─────────────────────

function clamp(v, lo = 0, hi = 20) {
  return Math.max(lo, Math.min(hi, v));
}

function scoreScientificInfluence(author) {
  // Solo mode: h-index log estimate, no graph centrality
  const h = author.h_index || 0;
  const hPct = Math.min(1.0, Math.log1p(h) / Math.log1p(100));
  // pr_norm=0.5, ev_norm=0.5 (no graph)
  const raw = 0.4 * 0.5 + 0.3 * 0.5 + 0.3 * hPct;
  return clamp(Math.round(raw * 20 * 100) / 100);
}

function scoreClinicalAlignment(author) {
  const targets = CONFIG.openalex_concepts;
  if (!targets.length) return 10;

  const conceptText = (author.concepts || [])
    .map((c) => (typeof c === "object" ? c.display_name || "" : String(c)))
    .join(" ")
    .toLowerCase();

  let matchedWeight = 0;
  let totalWeight = 0;
  for (const tc of targets) {
    totalWeight += tc.weight;
    if (tc.label.toLowerCase() && conceptText.includes(tc.label.toLowerCase())) {
      matchedWeight += tc.weight;
    }
  }
  if (totalWeight === 0) return 10;
  return clamp(Math.round((matchedWeight / totalWeight) * 20 * 100) / 100);
}

function scoreReachVisibility(author) {
  const citations = author.citation_count || 0;
  let citeScore = 0;
  if (citations > 0) {
    citeScore = Math.min(14, (Math.log10(citations) / 5.7) * 14);
  }
  // No co-author institutions in enrich mode
  return clamp(Math.round((citeScore) * 100) / 100);
}

function scoreNutritionOpenness(author) {
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
  return clamp(10 + matches * 2);
}

function computeOPSScore(author) {
  const sci = scoreScientificInfluence(author);
  const align = scoreClinicalAlignment(author);
  const reach = scoreReachVisibility(author);
  const nutr = scoreNutritionOpenness(author);
  const strat = 10; // No pharma data in browser enrichment
  const composite = Math.round((sci + align + reach + nutr + strat) * 100) / 100;

  const t = CONFIG.tier_thresholds;
  let tier = "D";
  if (composite >= t.A) tier = "A";
  else if (composite >= t.B) tier = "B";
  else if (composite >= t.C) tier = "C";

  return {
    ops_score: composite,
    tier,
    scientific_influence_score: sci,
    clinical_alignment_score: align,
    reach_visibility_score: reach,
    nutrition_openness_score: nutr,
    strategic_value_score: strat,
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

    // Token overlap
    let overlap = 0;
    for (const t of queryTokens) {
      if (candTokens.has(t)) overlap++;
    }
    const nameScore = overlap / Math.max(queryTokens.size, candTokens.size);

    // Institution boost
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

// ── CSV parsing (minimal, no dependencies) ─────────────────────────────

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

  // Handle both Node.js IncomingMessage and Web Request
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
      // Remove trailing \r\n-- if present
      if (content.endsWith("--\r\n")) content = content.slice(0, -4);
      else if (content.endsWith("\r\n")) content = content.slice(0, -2);
      return content;
    }
  }

  throw new Error("No file field found in multipart data");
}

// ── Main handler ───────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS headers
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

    // Parse the uploaded CSV
    const csvText = await parseMultipart(req);
    const contacts = parseCSV(csvText);

    if (!contacts.length) {
      res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No rows found in CSV" }));
      return;
    }

    // Send progress as SSE-like JSON stream
    const outputColumns = [
      "hs_object_id", "openalex_match_status", "ops_score", "kol_tier",
      "scientific_influence_score", "clinical_alignment_score",
      "pharma_entanglement_score", "openalex_id", "orcid",
      "top_paper_title", "top_paper_doi", "h_index", "citation_count",
      "institution", "nutrition_signal_keywords", "last_profiled_date",
      "nutrition_stance", "nutrition_stance_source",
    ];

    const enrichedRows = [];
    let matched = 0;
    let notFound = 0;

    for (const contact of contacts) {
      // Extract name from common column variants
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

      if (!name) {
        enrichedRows.push(emptyRow(hsId, "skip_no_name"));
        notFound++;
        continue;
      }

      // Search OpenAlex
      const author = await searchAuthor(name, institution, email);

      if (!author) {
        enrichedRows.push(emptyRow(hsId, "not_found"));
        notFound++;
        continue;
      }

      // Fetch recent work titles for nutrition scoring
      author.recent_work_titles = await fetchRecentTitles(author.openalex_id, email);

      // Compute OPS score
      const score = computeOPSScore(author);

      enrichedRows.push({
        hs_object_id: hsId,
        openalex_match_status: "matched",
        ops_score: score.ops_score,
        kol_tier: score.tier,
        scientific_influence_score: score.scientific_influence_score,
        clinical_alignment_score: score.clinical_alignment_score,
        pharma_entanglement_score: score.strategic_value_score,
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

      // Rate limit: 100ms between OpenAlex calls
      await new Promise((r) => setTimeout(r, 100));
    }

    // Build CSV response
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

function emptyRow(hsId, status) {
  return {
    hs_object_id: hsId,
    openalex_match_status: status,
    ops_score: "", kol_tier: "",
    scientific_influence_score: "", clinical_alignment_score: "",
    pharma_entanglement_score: "", openalex_id: "", orcid: "",
    top_paper_title: "", top_paper_doi: "", h_index: "",
    citation_count: "", institution: "", nutrition_signal_keywords: "",
    last_profiled_date: "", nutrition_stance: "", nutrition_stance_source: "",
  };
}
