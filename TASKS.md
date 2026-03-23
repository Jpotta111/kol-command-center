# Sprint Task Queue

## HOW TO DISPATCH
Terminal or Telegram: "Read CLAUDE.md and TASKS.md. Execute [Task ID]."

---

## S1-1 [DONE] — Create ops_config.json
Create config/ops_config.json with this exact content:
{
  "therapeutic_area": "T2D_metabolic_nutrition",
  "openalex_concepts": [
    {"id": "C2779323", "label": "Type 2 diabetes", "weight": 1.0},
    {"id": "C2986049", "label": "Obesity", "weight": 0.9},
    {"id": "C2778348", "label": "Metabolic syndrome", "weight": 0.9},
    {"id": "C126322002", "label": "Insulin resistance", "weight": 0.8},
    {"id": "C41008148", "label": "Dietary supplement", "weight": 0.6}
  ],
  "nutrition_keywords": [
    "low carbohydrate", "low-carbohydrate", "ketogenic",
    "carbohydrate restriction", "dietary intervention",
    "nutritional ketosis", "very low calorie", "caloric restriction"
  ],
  "filters": {
    "min_publications": 5,
    "min_citations": 50,
    "years_active_recent": 3
  },
  "ops_weights": {
    "scientific_influence": 20,
    "clinical_alignment": 20,
    "reach_visibility": 20,
    "nutrition_openness": 20,
    "strategic_value": 20
  },
  "tier_thresholds": {"A": 80, "B": 60, "C": 40},
  "target_author_count": 500,
  "polite_email": "your_email@gmail.com"
}
Done when: valid JSON file exists.
NOTE: openalex_concepts is deprecated on the /authors endpoint (returns 0 results).
Config now includes openalex_topics with equivalent topic IDs. Client uses topics.id filter.

## S1-2 [DONE] — openalex_client.py
Build pipeline/openalex_client.py:
- Reads concepts from config/ops_config.json
- Queries OpenAlex /authors endpoint filtered by concept IDs
- Uses mailto header (email from config)
- Returns list of author dicts: openalex_id, display_name, orcid,
  institution, h_index, citation_count, pub_count, concepts,
  recent_work_titles, coauthor_ids
- Cursor-based pagination, 100ms rate limiting, retry on 429
- Filters: min_publications, min_citations, active in last N years
Done when: test run prints first 10 authors with citation counts.

## S1-3 [DONE] — open_payments_client.py
Build pipeline/open_payments_client.py:
- Queries CMS Open Payments API (data.cms.gov)
- Input: NPI number OR name + institution
- Returns: {npi, total_payments_usd, pharma_company_count,
  payment_years, data_available: bool}
- If not found: {data_available: False, total_payments_usd: null}
- Never error out — missing data returns null fields gracefully
Done when: test lookup returns result dict without crashing.

## S1-4 [DONE] — ops_scorer.py
Build pipeline/ops_scorer.py:
- Inputs: author dict + pharma data dict + NetworkX graph
- Compute all 5 OPS dimensions (0-20 each)
  - Scientific: normalize PageRank + eigenvector, blend with h_index percentile
  - Alignment: weighted % concept match from config
  - Reach: log-normalized citations + distinct co-author institution count
  - Nutrition: 10 (neutral) + 2 per keyword match, cap at 20
  - Strategic: 20 - log-normalized pharma entanglement; null = 10
- Returns dict with composite score + subdimensions + tier
Done when: scores a mock author dict and returns valid score dict.

## S1-5 [DONE] — pipeline.py orchestrator
Build pipeline/pipeline.py:
1. Load config
2. Call openalex_client for target_author_count authors
3. Build NetworkX DiGraph: nodes=authors, edges=co-authorship weighted
4. Compute PageRank + eigenvector centrality
5. Call open_payments_client per author
6. Call ops_scorer per author
7. Export kol_graph.json: {nodes:[...], edges:[...]}
8. Export kol_export.csv with exact HubSpot column names
   (hs_object_id empty — filled after HubSpot export)
9. Print top 10 KOLs by OPS score as validation
Done when: runs end-to-end, prints top 10, both output files exist.
Use fictional names in any committed sample output.
NOTE: Use `--skip-payments` flag when CMS API is slow/down.
Usage: `python -m pipeline.pipeline -n 20 --skip-payments`

---

## SPRINT 1 COMPLETE

All data pipeline modules built and validated:
- S1-1: config/ops_config.json (with openalex_topics fix)
- S1-2: pipeline/openalex_client.py (OpenAlex /authors via topics)
- S1-3: pipeline/open_payments_client.py (CMS Open Payments DKAN API)
- S1-4: pipeline/ops_scorer.py (5-dimension OPS composite scoring)
- S1-5: pipeline/pipeline.py (full orchestrator with graph + exports)

---

## Sprint 2 Pre-Work (fix before S2-1)

### S2-0a [DONE] — Replace CMS live API with CSV batch lookup
Replaced live DKAN API with local parquet lookup.
- download_cms_data.py streams CMS CSVs → compact parquet (8.3GB CSV → 171MB parquet)
- open_payments_client.py loads parquet on first call, caches in memory
- Lookups: 170ms avg (vs 60-90s live API). 10 batch lookups in 1.7s total.
- Setup: `curl -L -o data/cms_payments/2024_general.csv <URL>` then `python -m pipeline.download_cms_data --from-local`

### S2-0b [DONE] — Fetch recent works to unlock Nutrition Openness
Added `_fetch_recent_work_titles()` to openalex_client.py.
- Fetches 20 most recent works per author from OpenAlex /works endpoint
- Populates `recent_work_titles` on each author dict
- Nutrition Openness now varies: e.g., Frank B. Hu = 12.0 (matched "low-carbohydrate")

---

## S2-1 [DONE] — profile_generator.py
Gemini 2.0 Flash-powered KOL intelligence profiles.
- Uses google.genai SDK (new) with GEMINI_API_KEY from .env
- Input: KOL node from kol_graph.json, auto-enriched with OpenAlex work titles
- Output: structured profile with summary, scientific positioning, nutrition
  stance (LOW/MEDIUM/HIGH), key papers, outreach angle, SME briefing, red flags
- Batch mode: profiles top N by OPS, writes to data/kol_profiles.json
- Usage: `python -m intelligence.profile_generator -n 5`
- Requires: GEMINI_API_KEY in .env (free at aistudio.google.com)

## S3-1 [DONE] — React dashboard
React + D3.js + Tailwind v4 dashboard with Vite bundler.
Three views:
1. Network Graph — D3.js force-directed graph, click nodes for profile sidebar
2. KOL Table — sortable/filterable, re-engagement queue, CSV export
3. CSV Import/Export — drag-and-drop HubSpot matching + enriched export
- Sample data with 10 fictional KOLs for local dev
- vercel.json configured for deployment
- `cd dashboard && npm install && npm run dev` → localhost:5173

---

## ALL SPRINTS COMPLETE

Sprint 1: Data Pipeline (S1-1 through S1-5)
Sprint 2: Gemini Intelligence Layer (S2-0a, S2-0b, S2-1)
Sprint 3: React Dashboard (S3-1)
