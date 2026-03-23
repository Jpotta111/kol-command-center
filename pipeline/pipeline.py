"""
KOL Command Center — Pipeline Orchestrator.

Wires together all Sprint 1 modules:
  1. Load config
  2. Fetch authors from OpenAlex
  3. Fetch co-authorship data and build NetworkX graph
  4. Compute graph centrality metrics
  5. Look up CMS Open Payments per author
  6. Score each author with OPS scorer
  7. Export kol_graph.json + kol_export.csv
  8. Print top 10 KOLs by OPS score
"""

import csv
import json
import logging
import time
from datetime import date
from pathlib import Path
from urllib.parse import urlencode

import networkx as nx
import requests

from pipeline.openalex_client import fetch_authors, load_config
from pipeline.open_payments_client import lookup_payments
from pipeline.ops_scorer import compute_ops_score, precompute_centrality

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# HubSpot CSV columns — exact names, never change
HUBSPOT_COLUMNS = [
    "hs_object_id", "ops_score", "kol_tier", "scientific_influence_score",
    "clinical_alignment_score", "pharma_entanglement_score", "openalex_id",
    "orcid", "top_paper_title", "top_paper_doi", "h_index", "citation_count",
    "institution", "nutrition_signal_keywords", "last_profiled_date",
    "nutrition_stance", "nutrition_stance_source",
]


def _fetch_coauthorships(
    authors: list[dict], config: dict
) -> dict[str, list[dict]]:
    """
    Fetch recent works for each author to extract co-authorship edges.

    Returns dict mapping author openalex_id to list of co-author dicts:
      [{openalex_id, display_name, institution}, ...]
    """
    email = config.get("polite_email", "")
    author_ids = {a["openalex_id"] for a in authors}
    coauthorships: dict[str, list[dict]] = {aid: [] for aid in author_ids}

    # Process authors in batches to avoid URL-length limits
    author_list = list(author_ids)
    batch_size = 25

    for batch_start in range(0, len(author_list), batch_size):
        batch = author_list[batch_start:batch_start + batch_size]
        # Strip URL prefix for filter — OpenAlex accepts short IDs
        short_ids = [aid.replace("https://openalex.org/", "") for aid in batch]
        author_filter = "|".join(short_ids)

        params = {
            "filter": f"authorships.author.id:{author_filter}",
            "per_page": 200,
            "select": "id,authorships",
            "mailto": email,
        }
        url = f"https://api.openalex.org/works?{urlencode(params)}"

        try:
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
        except requests.exceptions.RequestException as e:
            logger.warning("Failed to fetch works for co-authorship: %s", e)
            continue

        works = resp.json().get("results", [])

        for work in works:
            authorships = work.get("authorships", [])
            # Extract all author IDs in this work
            work_authors = []
            for aship in authorships:
                a = aship.get("author", {})
                aid = a.get("id", "")
                insts = aship.get("institutions", [])
                inst_name = insts[0].get("display_name", "") if insts else ""
                work_authors.append({
                    "openalex_id": aid,
                    "display_name": a.get("display_name", ""),
                    "institution": inst_name,
                })

            # For each of our target authors in this work, record co-authors
            work_author_ids = {wa["openalex_id"] for wa in work_authors}
            for target_id in batch:
                full_id = f"https://openalex.org/{target_id}" if not target_id.startswith("http") else target_id
                if full_id not in work_author_ids:
                    continue
                for wa in work_authors:
                    if wa["openalex_id"] != full_id:
                        coauthorships[full_id].append(wa)

        time.sleep(0.1)  # Rate limiting

    return coauthorships


def _build_graph(
    authors: list[dict], coauthorships: dict[str, list[dict]]
) -> nx.DiGraph:
    """
    Build a directed co-authorship graph.

    Nodes = authors. Edge A→B exists if A co-authored with B,
    weighted by number of shared works.
    """
    G = nx.DiGraph()

    # Add all authors as nodes
    for a in authors:
        G.add_node(a["openalex_id"], display_name=a["display_name"])

    # Add edges from co-authorship data
    known_ids = {a["openalex_id"] for a in authors}
    for author_id, coauthors in coauthorships.items():
        edge_counts: dict[str, int] = {}
        for ca in coauthors:
            ca_id = ca["openalex_id"]
            if ca_id in known_ids and ca_id != author_id:
                edge_counts[ca_id] = edge_counts.get(ca_id, 0) + 1

        for ca_id, weight in edge_counts.items():
            G.add_edge(author_id, ca_id, weight=weight)

    return G


def _enrich_author_with_coauthor_data(
    author: dict, coauthorships: dict[str, list[dict]]
) -> dict:
    """Add coauthor_ids and coauthor_institutions to author dict."""
    coauthors = coauthorships.get(author["openalex_id"], [])

    coauthor_ids = list({ca["openalex_id"] for ca in coauthors})
    coauthor_institutions = list({
        ca["institution"] for ca in coauthors if ca.get("institution")
    })

    author["coauthor_ids"] = coauthor_ids
    author["coauthor_institutions"] = coauthor_institutions
    return author


def _split_name(display_name: str) -> tuple[str, str]:
    """Split 'First Last' into (first, last). Best-effort."""
    parts = display_name.strip().split()
    if len(parts) >= 2:
        return parts[0], parts[-1]
    return "", display_name


def _export_graph_json(
    authors: list[dict], scores: list[dict], graph: nx.DiGraph, path: Path
):
    """Export graph as JSON with nodes and edges."""
    nodes = []
    for a, s in zip(authors, scores):
        nodes.append({
            "openalex_id": a["openalex_id"],
            "display_name": a["display_name"],
            "institution": a.get("institution"),
            "h_index": a.get("h_index", 0),
            "citation_count": a.get("citation_count", 0),
            **s,
        })

    edges = []
    for u, v, data in graph.edges(data=True):
        edges.append({
            "source": u,
            "target": v,
            "weight": data.get("weight", 1),
        })

    output = {"nodes": nodes, "edges": edges}
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(output, f, indent=2)
    logger.info("Exported graph JSON: %s (%d nodes, %d edges)", path, len(nodes), len(edges))


def _export_csv(
    authors: list[dict], scores: list[dict], pharma_results: list[dict], path: Path
):
    """Export HubSpot-compatible CSV with exact column names."""
    path.parent.mkdir(parents=True, exist_ok=True)

    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=HUBSPOT_COLUMNS)
        writer.writeheader()

        for a, s, p in zip(authors, scores, pharma_results):
            # Collect nutrition keywords found in this author's work
            nutrition_kws = []
            text = " ".join(a.get("recent_work_titles", [])).lower()
            for c in a.get("concepts", []):
                if isinstance(c, dict):
                    text += " " + c.get("display_name", "").lower()
                else:
                    text += " " + str(c).lower()

            row = {
                "hs_object_id": "",  # Filled after HubSpot import
                "ops_score": s["ops_score"],
                "kol_tier": s["tier"],
                "scientific_influence_score": s["scientific_influence_score"],
                "clinical_alignment_score": s["clinical_alignment_score"],
                "pharma_entanglement_score": s.get("strategic_value_score", ""),
                "openalex_id": a.get("openalex_id", ""),
                "orcid": a.get("orcid") or "",
                "top_paper_title": (a.get("recent_work_titles") or [""])[0] if a.get("recent_work_titles") else "",
                "top_paper_doi": "",
                "h_index": a.get("h_index", ""),
                "citation_count": a.get("citation_count", ""),
                "institution": a.get("institution") or "",
                "nutrition_signal_keywords": "",
                "last_profiled_date": date.today().isoformat(),
                "nutrition_stance": "",
                "nutrition_stance_source": "",
            }
            writer.writerow(row)

    logger.info("Exported CSV: %s (%d rows)", path, len(authors))


def run_pipeline(max_authors: int | None = None, skip_payments: bool = False):
    """
    Execute the full KOL discovery pipeline.

    Args:
        max_authors: Override target_author_count for testing.
        skip_payments: Skip CMS Open Payments lookups (faster test runs).
    """
    config = load_config()

    # ── Step 1: Fetch authors ─────────────────────────────────────
    print(f"[1/7] Fetching authors from OpenAlex...")
    authors = fetch_authors(config=config, max_authors=max_authors)
    print(f"       → {len(authors)} authors fetched")

    if not authors:
        print("No authors found. Check config and try again.")
        return

    # ── Step 2: Fetch co-authorship data ──────────────────────────
    print(f"[2/7] Fetching co-authorship data...")
    coauthorships = _fetch_coauthorships(authors, config)
    total_edges = sum(len(v) for v in coauthorships.values())
    print(f"       → {total_edges} co-authorship links found")

    # Enrich authors with co-author data
    for a in authors:
        _enrich_author_with_coauthor_data(a, coauthorships)

    # ── Step 3: Build co-authorship graph ─────────────────────────
    print(f"[3/7] Building NetworkX graph...")
    graph = _build_graph(authors, coauthorships)
    print(f"       → {graph.number_of_nodes()} nodes, {graph.number_of_edges()} edges")

    # ── Step 4: CMS Open Payments lookups ─────────────────────────
    pharma_results = []
    if skip_payments:
        print(f"[4/7] Skipping Open Payments lookups (--skip-payments)")
        pharma_results = [{"data_available": False}] * len(authors)
    else:
        print(f"[4/7] Looking up CMS Open Payments ({len(authors)} authors)...")
        for i, a in enumerate(authors):
            first, last = _split_name(a["display_name"])
            pharma = lookup_payments(
                first_name=first,
                last_name=last,
                years=[2024],  # Most recent year only for speed
            )
            pharma_results.append(pharma)
            if (i + 1) % 5 == 0:
                print(f"       → {i + 1}/{len(authors)} looked up")
        print(f"       → {len(pharma_results)} lookups complete")

    # ── Step 5: Score all authors ─────────────────────────────────
    print(f"[5/7] Computing OPS scores...")
    population_h = [a.get("h_index", 0) for a in authors]
    centrality_map = precompute_centrality(graph) if graph.number_of_nodes() > 0 else {}
    scores = []
    for a, p in zip(authors, pharma_results):
        s = compute_ops_score(
            author=a,
            pharma_data=p,
            graph=graph,
            config=config,
            population_h_indices=population_h,
            centrality_map=centrality_map,
        )
        scores.append(s)

    # ── Step 6: Export outputs ────────────────────────────────────
    print(f"[6/7] Exporting outputs...")
    graph_path = DATA_DIR / "kol_graph.json"
    csv_path = DATA_DIR / "kol_export.csv"
    _export_graph_json(authors, scores, graph, graph_path)
    _export_csv(authors, scores, pharma_results, csv_path)

    # ── Step 7: Print top 10 ─────────────────────────────────────
    print(f"[7/7] Top KOLs by OPS score:\n")

    ranked = sorted(
        zip(authors, scores, pharma_results),
        key=lambda x: x[1]["ops_score"],
        reverse=True,
    )

    header = (
        f"{'#':<3} {'Name':<30} {'Institution':<25} "
        f"{'OPS':>5} {'Tier':>4}  "
        f"{'Sci':>4} {'Alg':>4} {'Rch':>4} {'Nut':>4} {'Str':>4}"
    )
    print("=" * len(header))
    print(header)
    print("=" * len(header))

    for i, (a, s, p) in enumerate(ranked[:10], 1):
        inst = (a.get("institution") or "—")[:24]
        name = a["display_name"][:29]
        print(
            f"{i:<3} {name:<30} {inst:<25} "
            f"{s['ops_score']:>5.1f} {s['tier']:>4}  "
            f"{s['scientific_influence_score']:>4.1f} "
            f"{s['clinical_alignment_score']:>4.1f} "
            f"{s['reach_visibility_score']:>4.1f} "
            f"{s['nutrition_openness_score']:>4.1f} "
            f"{s['strategic_value_score']:>4.1f}"
        )

    print("=" * len(header))
    print(f"\nOutputs written to:")
    print(f"  {graph_path}")
    print(f"  {csv_path}")


if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    parser = argparse.ArgumentParser(description="KOL Command Center Pipeline")
    parser.add_argument(
        "-n", "--max-authors", type=int, default=None,
        help="Override target_author_count (e.g., 20 for testing)",
    )
    parser.add_argument(
        "--skip-payments", action="store_true",
        help="Skip CMS Open Payments lookups for faster test runs",
    )
    args = parser.parse_args()

    # Startup diagnostics
    config_path = Path(__file__).resolve().parent.parent / "config" / "ops_config.json"
    print(f"KOL Command Center Pipeline")
    print(f"  Config:  {config_path}")
    if not config_path.exists():
        print(f"  ERROR: Config file not found at {config_path}")
        print(f"  Run from the repo root or check your clone.")
        raise SystemExit(1)
    if config_path.stat().st_size == 0:
        print(f"  ERROR: Config file is empty (0 bytes)")
        print(f"  This repo may be an incomplete clone. Check git status.")
        raise SystemExit(1)
    print(f"  Data:    {DATA_DIR}")
    print(f"  Authors: {args.max_authors or 'config default'}")
    print(f"  Payments: {'skip' if args.skip_payments else 'enabled'}")
    print()

    run_pipeline(max_authors=args.max_authors, skip_payments=args.skip_payments)
