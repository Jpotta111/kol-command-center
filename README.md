# KOL Command Center

A KOL intelligence platform for Medical Affairs teams built on public data: OpenAlex, CMS Open Payments, ClinicalTrials.gov. Graph-scored with NetworkX. AI-profiled with Gemini. React + D3.js dashboard.

## What It Does

Discovers, scores, and profiles Key Opinion Leaders across any therapeutic area using publicly available data. No proprietary databases required.

**Pipeline** (Python):
1. Queries OpenAlex for researchers by therapeutic topic
2. Builds co-authorship network graph (NetworkX)
3. Computes PageRank + eigenvector centrality
4. Pulls CMS Open Payments data for pharma entanglement scoring
5. Scores each KOL 0-100 across 5 dimensions (OPS framework)
6. Generates AI intelligence profiles via Gemini 2.0 Flash
7. Exports HubSpot-ready CSV + network graph JSON

**Dashboard** (React + D3.js):
- Force-directed co-authorship graph with clickable KOL profiles
- Sortable/filterable table with re-engagement queue
- CSV import/export for HubSpot integration

## OPS Scoring (0-100)

| Dimension (0-20 each) | Data Source |
|---|---|
| Scientific Influence | PageRank, eigenvector centrality, h-index |
| Clinical Alignment | OpenAlex topic/concept matching |
| Reach & Visibility | Citation count, institutional diversity |
| Nutrition Openness | Keyword detection in recent publications |
| Strategic Value | Inverse pharma entanglement (CMS Open Payments) |

**Tiers:** A (80-100) · B (60-79) · C (40-59) · D (<40)

## Quick Start

```bash
# Pipeline
python -m venv .venv && source .venv/bin/activate
pip install requests networkx scipy pandas pyarrow google-genai python-dotenv

# Configure
cp .env.example .env   # add your GEMINI_API_KEY

# Run pipeline (20 authors for testing)
python -m pipeline.pipeline -n 20 --skip-payments

# Generate AI profiles
python -m intelligence.profile_generator -n 5

# Dashboard
cd dashboard && npm install && npm run dev
# → http://localhost:5173
```

## Architecture

```
pipeline/
  openalex_client.py     → OpenAlex API (authors, works, co-authorship)
  open_payments_client.py → CMS Open Payments (local parquet)
  ops_scorer.py          → OPS composite scoring (5 dimensions)
  pipeline.py            → orchestrator → kol_graph.json + kol_export.csv
  download_cms_data.py   → CMS CSV → parquet converter

intelligence/
  profile_generator.py   → Gemini 2.0 Flash structured profiles

dashboard/
  src/App.jsx            → React + D3.js + Tailwind dashboard
  src/sample_data.js     → 10 fictional KOLs for local dev

config/
  ops_config.json        → therapeutic area, scoring weights, filters
```

## Configuration

All configuration lives in `config/ops_config.json`. Change the therapeutic area by updating topic IDs, keywords, and concept weights — no code changes required.

## Data Privacy

- `data/` is gitignored — real KOL data stays local only
- No proprietary data is ever committed
- `data/sample/` contains fictional data only
- CMS Open Payments is public federal data
- OpenAlex is fully open access
