# KOL Command Center — Dashboard

React + D3.js + Tailwind dashboard for visualizing KOL intelligence data.

## Setup

```bash
cd dashboard
npm install
```

## Development

```bash
npm run dev    # → http://localhost:5173
```

Loads sample data by default. To use real pipeline data, copy output files:

```bash
cp ../data/kol_graph.json public/data/
cp ../data/kol_profiles.json public/data/
```

## Production Build

```bash
npm run build    # → dashboard/dist/
npm run preview  # preview the production build locally
```

## Deploy to Vercel

```bash
# From repo root
vercel deploy
```

The `vercel.json` at the repo root handles build config automatically.

## Views

1. **Network Graph** — D3.js force-directed co-authorship graph. Click nodes for profile panel.
2. **KOL Table** — Sortable/filterable table with CSV export. Re-engagement queue highlights Tier A/B.
3. **CSV Import/Export** — Drag-and-drop HubSpot CSV matching + enriched export.
