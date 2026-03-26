/**
 * Vercel serverless function: CSV enrichment via PubMed (primary) + OpenAlex.
 *
 * POST /api/enrich  (multipart/form-data with a "file" field)
 *
 * Architecture: PubMed is the primary source for affiliation and clinical
 * relevance scoring. OpenAlex supplements with h-index and citation count.
 *
 * OPS dimensions (0-20 each, 100 total):
 *   1. Institutional Credibility — from PubMed affiliation
 *   2. Clinical Relevance — weighted MeSH + text word matching
 *   3. Collaboration Signal — Virta CoAuthor > AMC+h > pharma
 *   4. Nutrition/Lifestyle Openness — keyword detection
 *   5. Strategic Reach — citations + h-index + AMC
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

// ── MeSH term tiers (Virta-calibrated) ─────────────────────────────────

const MESH_PRIMARY = [
  "Diabetes Mellitus, Type 2", "Diet, Ketogenic",
  "Diet, Carbohydrate-Restricted", "Insulin Resistance",
  "Glycated Hemoglobin", "Hypoglycemic Agents",
  "Blood Glucose", "Non-alcoholic Fatty Liver Disease",
];

const MESH_SECONDARY = [
  "Obesity", "Weight Loss", "Dyslipidemias", "Triglycerides",
  "Hypertension", "C-Reactive Protein", "Cardiovascular Diseases",
  "Metabolic Syndrome", "Telemedicine", "Pancreatic Neoplasms",
  "Mental Disorders", "Depression", "Cognitive Dysfunction", "Fatty Liver",
  "Economics, Medical", "Cost-Benefit Analysis", "Health Care Costs",
  "Cost Savings", "Quality-Adjusted Life Years",
  "Outcome Assessment, Health Care",
];

const TEXT_WORDS = [
  "nutritional ketosis", "carbohydrate restriction",
  "low carbohydrate", "low-carbohydrate", "continuous care",
  "diabetes reversal", "diabetes remission", "ketogenic diet",
  "MASLD", "MASH", "metabolic-associated steatotic",
  "metabolic-associated steatohepatitis", "NAFLD", "NASH",
  "pancreatic cancer", "metabolic psychiatry",
  "cognitive function", "brain health",
  "health economics", "cost effectiveness", "cost-effectiveness",
  "claims analysis", "claims data",
  "real world evidence", "real-world evidence",
  "budget impact", "healthcare utilization",
  "value-based care", "QALY", "payer",
];

// ── Institutional tiers ────────────────────────────────────────────────

const TOP_AMC_KEYWORDS = [
  "johns hopkins", "mayo clinic", "harvard", "brigham and women",
  "massachusetts general", "ucsf", "stanford", "yale",
  "columbia university", "penn medicine", "university of pennsylvania",
  "vanderbilt", "duke", "cleveland clinic", "mount sinai", "nyu langone",
  "university of michigan", "michigan medicine", "university of chicago",
  "northwestern", "emory", "university of pittsburgh", "upmc",
  "university of washington", "washington university", "baylor college",
  "uc san diego", "scripps", "md anderson", "memorial sloan",
  "dana-farber", "cedars-sinai", "university of virginia",
  "unc chapel hill", "university of north carolina", "oregon health",
  "university of colorado", "tufts", "boston university", "ut southwestern",
  "university of florida", "university of wisconsin", "weill cornell",
  "albert einstein", "university of california", "ohio state",
  "karolinska", "oxford", "cambridge", "university college london",
];

const MAJOR_SYSTEM_KEYWORDS = [
  "university hospital", "university medical", "medical school",
  "school of medicine", "college of medicine", "medical college",
  "teaching hospital", "academic medical", "health science",
  "national institutes", "nih", "cdc", "veterans affairs", "va medical",
];

function isTopAMC(inst) {
  if (!inst) return false;
  const l = inst.toLowerCase();
  return TOP_AMC_KEYWORDS.some((kw) => l.includes(kw));
}

function isMajorSystem(inst) {
  if (!inst) return false;
  const l = inst.toLowerCase();
  return MAJOR_SYSTEM_KEYWORDS.some((kw) => l.includes(kw));
}

// ── PubMed helpers ─────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pubmedSearch(query, retmax = 50) {
  const params = new URLSearchParams({
    db: "pubmed", term: query, retmax: String(retmax), retmode: "json",
  });
  const resp = await fetch(`${PUBMED_BASE}/esearch.fcgi?${params}`);
  if (!resp.ok) throw new Error(`PubMed esearch ${resp.status}`);
  const data = await resp.json();
  const result = data?.esearchresult || {};
  return {
    count: parseInt(result.count || "0", 10),
    idlist: result.idlist || [],
  };
}

async function pubmedFetchXml(pmids) {
  if (!pmids.length) return "";
  const params = new URLSearchParams({
    db: "pubmed", id: pmids.join(","), retmode: "xml",
  });
  const resp = await fetch(`${PUBMED_BASE}/efetch.fcgi?${params}`);
  if (!resp.ok) throw new Error(`PubMed efetch ${resp.status}`);
  return await resp.text();
}

function extractAffiliation(xml) {
  // Get affiliation from the first (most recent) article
  const affMatch = xml.match(/<Affiliation>([^<]+)<\/Affiliation>/);
  return affMatch ? affMatch[1].trim() : null;
}

function extractAllAffiliations(xml) {
  // Get ALL affiliation strings across all articles
  const re = /<Affiliation>([^<]+)<\/Affiliation>/g;
  const affiliations = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    affiliations.push(m[1].trim());
  }
  return affiliations;
}

function extractModalInstitution(affiliations) {
  // Parse institution names from affiliation strings and find most frequent
  // All AMC keywords serve as institution identifiers
  const allKeywords = [...TOP_AMC_KEYWORDS, ...MAJOR_SYSTEM_KEYWORDS];
  const counts = {};

  for (const aff of affiliations) {
    const lower = aff.toLowerCase();

    // Try matching against known institution keywords
    let matched = null;
    for (const kw of allKeywords) {
      if (lower.includes(kw)) {
        // Use the keyword as the canonical key
        matched = kw;
        break;
      }
    }

    if (!matched) {
      // Fallback: parse comma-delimited segments, take 2nd segment
      // "Department of X, Institution Name, City, State"
      const parts = aff.split(",").map((s) => s.trim());
      if (parts.length >= 2) {
        matched = parts[1].toLowerCase();
      }
    }

    if (matched) {
      counts[matched] = (counts[matched] || 0) + 1;
    }
  }

  // Find most frequent institution that appears >= 2 times
  let best = null;
  let bestCount = 0;
  for (const [inst, count] of Object.entries(counts)) {
    if (count > bestCount) {
      bestCount = count;
      best = inst;
    }
  }

  if (bestCount < 2) return null;

  // Return the original affiliation string that matches the winning keyword
  for (const aff of affiliations) {
    if (aff.toLowerCase().includes(best)) return aff;
  }
  return null;
}

function extractMeshTerms(xml) {
  // Extract all MeSH descriptor names from the XML
  const terms = [];
  const re = /<DescriptorName[^>]*>([^<]+)<\/DescriptorName>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    terms.push(m[1]);
  }
  return terms;
}

function extractTitleAbstracts(xml) {
  // Extract title + abstract text for text-word matching
  const texts = [];
  const titleRe = /<ArticleTitle>([^<]+)<\/ArticleTitle>/g;
  const abstractRe = /<AbstractText[^>]*>([^<]+)<\/AbstractText>/g;
  let m;
  while ((m = titleRe.exec(xml)) !== null) texts.push(m[1]);
  while ((m = abstractRe.exec(xml)) !== null) texts.push(m[1]);
  return texts.join(" ");
}

// ── PubMed-based author lookup ─────────────────────────────────────────

async function lookupPubMed(name) {
  // Search for author's papers (50 for better MeSH coverage)
  const search = await pubmedSearch(`${name}[Author]`, 50);
  if (search.count === 0 || !search.idlist.length) return null;

  await sleep(400);

  // Fetch XML for papers
  const xml = await pubmedFetchXml(search.idlist);

  // Extract affiliations: single most-recent + all for modal vote
  const affiliation = extractAffiliation(xml);
  const allAffiliations = extractAllAffiliations(xml);
  const modalAffiliation = extractModalInstitution(allAffiliations);

  // Extract MeSH terms across all fetched papers
  const meshTerms = extractMeshTerms(xml);

  // Extract text for TIAB matching
  const textContent = extractTitleAbstracts(xml);

  return {
    total_count: search.count,
    fetched_count: search.idlist.length,
    affiliation,
    modal_affiliation: modalAffiliation,
    all_affiliations: allAffiliations,
    mesh_terms: meshTerms,
    text_content: textContent,
  };
}

// ── OPS Dimension 1: Institutional Credibility (0-20) ──────────────────

function scoreInstitutionalCredibility(institution, hIndex) {
  const inst = institution || "";
  if (isTopAMC(inst)) {
    const bonus = Math.min(4, Math.floor((hIndex || 0) / 25));
    return clamp(16 + bonus);
  }
  if (isMajorSystem(inst)) return clamp(13);
  if (inst) return clamp(7);
  return clamp(3);
}

// ── OPS Dimension 2: Clinical Relevance (0-20) ────────────────────────
// Per-paper MeSH matching from fetched PubMed XML

function scoreClinicalRelevance(pubmedData) {
  if (!pubmedData || pubmedData.fetched_count === 0) return 5; // neutral

  const meshTerms = pubmedData.mesh_terms;
  const textContent = (pubmedData.text_content || "").toLowerCase();
  const fetchedCount = pubmedData.fetched_count;

  // Count primary MeSH matches (each paper can contribute multiple)
  let primaryHits = 0;
  for (const term of MESH_PRIMARY) {
    primaryHits += meshTerms.filter((m) => m === term).length;
  }

  // Count secondary MeSH matches
  let secondaryHits = 0;
  for (const term of MESH_SECONDARY) {
    secondaryHits += meshTerms.filter((m) => m === term).length;
  }

  // Count text word matches in titles/abstracts
  let textHits = 0;
  for (const tw of TEXT_WORDS) {
    // Count occurrences (papers mentioning term)
    const re = new RegExp(tw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const matches = textContent.match(re);
    if (matches) textHits += matches.length;
  }

  // Normalize: average hits per paper, then scale to dimension
  // With 50 papers, a dedicated keto/T2D researcher might have:
  //   ~20 primary MeSH hits (0.4/paper), ~15 secondary (0.3), ~25 text (0.5)
  // Multipliers tuned so those ratios map to ~8, ~4, ~8 respectively
  const primaryScore = Math.min(8, (primaryHits / fetchedCount) * 20);
  const secondaryScore = Math.min(4, (secondaryHits / fetchedCount) * 12);
  const textScore = Math.min(8, (textHits / fetchedCount) * 16);

  return clamp(Math.round((primaryScore + secondaryScore + textScore) * 100) / 100);
}

// ── OPS Dimension 3: Collaboration Signal (0-20) ──────────────────────

function scoreCollaborationSignal(institution, hIndex, contact) {
  const coauthorFlag = (
    contact["Virta Paper CoAuthor"] ||
    contact["virta_paper_coauthor"] ||
    contact["Virta Paper Coauthor"] || ""
  ).toLowerCase();

  if (["true", "yes", "1"].includes(coauthorFlag)) {
    return { score: 20, reason: "Virta Paper CoAuthor" };
  }
  if ((hIndex || 0) > 30 && isTopAMC(institution)) {
    return { score: 14, reason: "Top AMC + high h-index" };
  }
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
  if (collaborationScore === 20 && score < 12) score = 12;
  return score;
}

// ── OPS Dimension 5: Strategic Reach (0-20) ────────────────────────────

function scoreStrategicReach(citations, hIndex, institution) {
  let score = 0;
  if (citations > 10000) score += 8;
  else if (citations > 1000) score += 5;
  else if (citations > 100) score += 3;

  if (hIndex > 50) score += 4;
  else if (hIndex >= 20) score += 2;

  if (isTopAMC(institution)) score += 4;

  return clamp(score);
}

// ── Composite scorer ───────────────────────────────────────────────────

function clamp(v, lo = 0, hi = 20) {
  return Math.max(lo, Math.min(hi, v));
}

function computeTier(score) {
  const t = CONFIG.tier_thresholds;
  if (score >= t.A) return "A";
  if (score >= t.B) return "B";
  if (score >= t.C) return "C";
  return "D";
}

// ── OpenAlex: h-index + citations only ─────────────────────────────────

async function fetchOpenAlexMetrics(name, institution, email) {
  const params = new URLSearchParams({
    search: name, per_page: "5",
    select: "id,display_name,orcid,last_known_institutions,summary_stats,cited_by_count,works_count,topics,x_concepts",
    mailto: email,
  });

  try {
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
      for (const t of queryTokens) { if (candTokens.has(t)) overlap++; }
      const nameScore = overlap / Math.max(queryTokens.size, candTokens.size);

      let instBoost = 0;
      if (queryInst) {
        for (const inst of raw.last_known_institutions || []) {
          const iName = (inst.display_name || "").toLowerCase();
          if (iName.includes(queryInst) || queryInst.includes(iName)) {
            instBoost = 0.2; break;
          }
        }
      }

      const confidence = Math.min(1.0, nameScore + instBoost);
      if (confidence > bestScore) { bestScore = confidence; bestMatch = raw; }
    }

    if (bestScore < 0.6 || !bestMatch) return null;

    const topics = bestMatch.topics || bestMatch.x_concepts || [];
    return {
      openalex_id: bestMatch.id || "",
      display_name: bestMatch.display_name || "",
      orcid: bestMatch.orcid || null,
      h_index: (bestMatch.summary_stats || {}).h_index || 0,
      citation_count: bestMatch.cited_by_count || 0,
      pub_count: bestMatch.works_count || 0,
      concepts: topics.map((c) => ({
        id: c.id || "", display_name: c.display_name || "", score: c.score || 0,
      })),
    };
  } catch {
    return null;
  }
}

async function fetchRecentTitles(authorId, email) {
  if (!authorId) return [];
  const shortId = authorId.replace("https://openalex.org/", "");
  const params = new URLSearchParams({
    filter: `authorships.author.id:${shortId}`,
    per_page: "20", select: "id,title,publication_year",
    sort: "publication_year:desc", mailto: email,
  });
  try {
    const resp = await fetch(`${OPENALEX_BASE}/works?${params}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.results || []).map((w) => w.title).filter(Boolean);
  } catch { return []; }
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
    headers.forEach((h, idx) => { row[h.trim()] = (values[idx] || "").trim(); });
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = []; let current = ""; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { result.push(current); current = ""; }
      else current += ch;
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
    chunks.push(Buffer.from(await req.arrayBuffer()));
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

  if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders); res.end(); return; }
  if (req.method !== "POST") {
    res.writeHead(405, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" })); return;
  }

  try {
    const email = req.headers["x-openalex-email"] || process.env.OPENALEX_EMAIL || "";
    const csvText = await parseMultipart(req);
    const contacts = parseCSV(csvText);

    if (!contacts.length) {
      res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No rows found in CSV" })); return;
    }

    const outputColumns = [
      "hs_object_id", "openalex_match_status", "existing_kol_tier",
      "ops_score", "kol_tier",
      "institutional_credibility_score", "clinical_relevance_score",
      "collaboration_signal_score", "collaboration_reason",
      "nutrition_openness_score", "strategic_reach_score",
      "pubmed_affiliation", "institution_source",
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

      const csvInstitution = contact.institution || contact.Institution ||
        contact.company || contact.Company || "";
      const hsId = contact.hs_object_id || contact["Record ID"] || "";
      const existingTier = contact["MA_OPS Tier"] || contact["ma_ops_tier"] || "";

      if (!name) {
        enrichedRows.push(emptyRow(hsId, "skip_no_name", existingTier));
        notFound++; continue;
      }

      // Step 1: PubMed lookup (primary source for affiliation + MeSH)
      const pubmed = await lookupPubMed(name);
      await sleep(400);

      // Step 2: OpenAlex for h-index + citations (supplementary)
      const oaMetrics = await fetchOpenAlexMetrics(name, csvInstitution, email);
      await sleep(100);

      if (!pubmed && !oaMetrics) {
        enrichedRows.push(emptyRow(hsId, "not_found", existingTier));
        notFound++; continue;
      }

      // Institution resolution — priority stack
      let institution = "";
      let institutionSource = "";
      const pubmedAffiliation = pubmed?.affiliation || "";

      if (csvInstitution) {
        // PRIORITY 1: HubSpot CSV input (highest trust — human entered)
        institution = csvInstitution;
        institutionSource = "hubspot";
      } else if (pubmed?.modal_affiliation) {
        // PRIORITY 2: Modal institution from recent PubMed papers
        institution = pubmed.modal_affiliation;
        institutionSource = "pubmed_modal";
      } else if (oaMetrics?.institution) {
        // PRIORITY 3: OpenAlex last_known_institution
        institution = oaMetrics.institution;
        institutionSource = "openalex";
      } else if (pubmedAffiliation) {
        // PRIORITY 4: Single most-recent PubMed paper (last resort)
        institution = pubmedAffiliation;
        institutionSource = "pubmed_recent";
      }
      const hIndex = oaMetrics?.h_index || 0;
      const citationCount = oaMetrics?.citation_count || 0;

      // Fetch recent work titles for nutrition openness
      const recentTitles = oaMetrics?.openalex_id
        ? await fetchRecentTitles(oaMetrics.openalex_id, email)
        : [];

      const authorForNutrition = {
        recent_work_titles: recentTitles,
        concepts: oaMetrics?.concepts || [],
      };

      // Score all 5 dimensions
      const instCred = scoreInstitutionalCredibility(institution, hIndex);
      const clinRel = scoreClinicalRelevance(pubmed);
      const collab = scoreCollaborationSignal(institution, hIndex, contact);
      const nutrOpen = scoreNutritionOpenness(authorForNutrition, collab.score);
      const stratReach = scoreStrategicReach(citationCount, hIndex, institution);

      const composite = Math.round(
        (instCred + clinRel + collab.score + nutrOpen + stratReach) * 100
      ) / 100;

      enrichedRows.push({
        hs_object_id: hsId,
        openalex_match_status: pubmed ? "matched" : "openalex_only",
        existing_kol_tier: existingTier,
        ops_score: composite,
        kol_tier: computeTier(composite),
        institutional_credibility_score: instCred,
        clinical_relevance_score: clinRel,
        collaboration_signal_score: collab.score,
        collaboration_reason: collab.reason,
        nutrition_openness_score: nutrOpen,
        strategic_reach_score: stratReach,
        pubmed_affiliation: pubmedAffiliation,
        institution_source: institutionSource,
        openalex_id: oaMetrics?.openalex_id || "",
        orcid: oaMetrics?.orcid || "",
        top_paper_title: (recentTitles || [])[0] || "",
        top_paper_doi: "",
        h_index: hIndex,
        citation_count: citationCount,
        institution,
        nutrition_signal_keywords: "",
        last_profiled_date: new Date().toISOString().split("T")[0],
        nutrition_stance: "",
        nutrition_stance_source: "",
      });
      matched++;
    }

    const csvHeader = outputColumns.join(",");
    const csvRows = enrichedRows.map((row) =>
      outputColumns.map((col) => escapeCSVField(row[col])).join(",")
    );
    const csvOutput = [csvHeader, ...csvRows].join("\r\n");

    res.writeHead(200, {
      ...corsHeaders, "Content-Type": "text/csv",
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
    hs_object_id: hsId, openalex_match_status: status,
    existing_kol_tier: existingTier || "",
    ops_score: "", kol_tier: "",
    institutional_credibility_score: "", clinical_relevance_score: "",
    collaboration_signal_score: "", collaboration_reason: "",
    nutrition_openness_score: "", strategic_reach_score: "",
    pubmed_affiliation: "", institution_source: "",
    openalex_id: "", orcid: "", top_paper_title: "", top_paper_doi: "",
    h_index: "", citation_count: "", institution: "",
    nutrition_signal_keywords: "", last_profiled_date: "",
    nutrition_stance: "", nutrition_stance_source: "",
  };
}
