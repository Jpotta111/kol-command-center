# KOL Command Center — Claude Code Context

## What This Is
General-purpose KOL intelligence platform for Medical Affairs teams.
Built on public data only. No proprietary data is ever committed to this repo.
Currently configured for T2D / metabolic health / nutrition.

## Architecture
Data Sources (all free/public):
- OpenAlex API — authors, papers, citations, concepts, co-authorship
- CMS Open Payments — pharma financial relationships by NPI
- ClinicalTrials.gov — PI/co-investigator relationships
- ORCID — verified author identity

Pipeline (Python):
- openalex_client.py — query authors by therapeutic concept
- open_payments_client.py — pharma entanglement by NPI
- ops_scorer.py — OPS composite scoring
- pipeline.py — orchestrator, outputs kol_graph.json + kol_export.csv

Intelligence Layer:
- profile_generator.py — reads KOL node, calls Gemini 2.0 Flash
- LLM_PROVIDER = "gemini" — never use Claude API

Dashboard (Sprint 3, not yet built):
- React + D3.js, Vercel, Google OAuth

## OPS Scoring (0-100)
1. Scientific Influence (0-20): NetworkX PageRank + eigenvector + h-index
2. Clinical Alignment (0-20): OpenAlex concept % match to target area
3. Reach & Visibility (0-20): citations + institutional diversity
4. Nutrition Openness (0-20): keyword detection; overridden by HubSpot tags
5. Strategic Value (0-20): institution tier + pharma entanglement inverse

Tiers: A=80-100, B=60-79, C=40-59, D=<40

## HubSpot CSV Columns (exact names — never change)
hs_object_id, ops_score, kol_tier, scientific_influence_score,
clinical_alignment_score, pharma_entanglement_score, openalex_id,
orcid, top_paper_title, top_paper_doi, h_index, citation_count,
institution, nutrition_signal_keywords, last_profiled_date,
nutrition_stance, nutrition_stance_source

Merge key: hs_object_id

## Critical Constraints
- NEVER commit real KOL names or real data
- data/ is gitignored — real data local only
- data/sample/ = fictional data only
- Always use Gemini API (GEMINI_API_KEY), never Claude API
- HubSpot = CSV only, no API calls
- All config in config/ops_config.json — no hardcoding
- Must work for any therapeutic area by changing config only

## Sprint Status
Sprint 1: COMPLETE — data pipeline
Sprint 2: COMPLETE — Gemini intelligence layer
Sprint 3: COMPLETE — React dashboard

## File Map
pipeline/pipeline.py — main orchestrator
pipeline/openalex_client.py — OpenAlex API
pipeline/open_payments_client.py — CMS Open Payments
pipeline/ops_scorer.py — scoring logic
intelligence/profile_generator.py — Gemini profiles
config/ops_config.json — all configuration
data/sample/ — fictional test data only
TASKS.md — sprint queue
