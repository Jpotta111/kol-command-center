# KOL Command Center — Claude Code Context
## What This Is
General-purpose KOL intelligence platform for Medical Affairs teams.
Built on public data only. No proprietary data is ever committed.
Configurable for any therapeutic area via config/ops_config.json.
Currently configured for T2D / metabolic health / nutrition as a demo.
Public repo: github.com/Jpotta111/kol-command-center
Live deploy: kol-command-center.vercel.app
## Architecture
Data Sources (all free/public):
- OpenAlex API — authors, papers, citations, co-authorship
- PubMed E-utilities — MeSH/TIAB clinical relevance scoring
- CMS Open Payments — pharma financial relationships by NPI
- Google Search grounding (via Gemini) — commercial enrichment
Pipeline (Python):
- pipeline/openalex_client.py — query authors, fetch recent works
- pipeline/open_payments_client.py — pharma entanglement by NPI
- pipeline/ops_scorer.py — scoring interface (methodology proprietary)
- pipeline/pipeline.py — orchestrator → kol_graph.json + kol_export.csv
API (Vercel serverless, 6 endpoints):
- api/enrich.js, api/profile.js, api/cred-review.js
- api/discover-leads.js, api/commercial-enrich.js, api/publications.js
Dashboard: React + D3.js (Vercel)
## Configuration
All therapeutic area, scoring, and pipeline config lives in:
  config/ops_config.json
Change the config to adapt this platform to any medical specialty.
## Critical Constraints
- NEVER commit real KOL data, HubSpot records, or contact names
- data/ is gitignored — real data local only
- data/sample/ must contain ONLY fictional names
- .env is gitignored — never commit API keys
- HubSpot = CSV only, no live API calls
- LLM: Gemini API (GEMINI_API_KEY env var)
