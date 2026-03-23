"""
OPS (Outreach Prioritization Score) scorer.

Computes a 0-100 composite score across 5 dimensions (0-20 each):
  1. Scientific Influence — PageRank + eigenvector + h-index percentile
  2. Clinical Alignment  — weighted concept match to config targets
  3. Reach & Visibility  — log-normalized citations + co-author institution diversity
  4. Nutrition Openness   — keyword matches in titles/concepts (neutral baseline)
  5. Strategic Value      — inverse pharma entanglement

Inputs: author dict, pharma data dict, NetworkX graph, config dict.
"""

import json
import logging
import math
from pathlib import Path

logger = logging.getLogger(__name__)


def load_config(config_path: str | None = None) -> dict:
    if config_path is None:
        config_path = str(
            Path(__file__).resolve().parent.parent / "config" / "ops_config.json"
        )
    with open(config_path) as f:
        return json.load(f)


def _clamp(value: float, lo: float = 0.0, hi: float = 20.0) -> float:
    return max(lo, min(hi, value))


def _percentile_rank(value: float, population: list[float]) -> float:
    """Return 0.0-1.0 percentile rank of value within population."""
    if not population:
        return 0.5
    below = sum(1 for v in population if v < value)
    return below / len(population)


# ── Dimension 1: Scientific Influence ─────────────────────────────────

def precompute_centrality(graph) -> dict:
    """
    Precompute and min-max normalize PageRank + eigenvector centrality.

    Returns dict mapping node_id → {"pr_norm": float, "ev_norm": float}.
    Call once, pass result to score_scientific_influence via centrality_map.
    """
    import networkx as nx

    pr = nx.pagerank(graph)

    try:
        ev = nx.eigenvector_centrality(graph, max_iter=500, tol=1e-06)
    except nx.PowerIterationFailedConvergence:
        ev = {n: 1.0 / graph.number_of_nodes() for n in graph.nodes()}

    pr_vals = list(pr.values())
    ev_vals = list(ev.values())
    pr_min, pr_max = min(pr_vals), max(pr_vals)
    ev_min, ev_max = min(ev_vals), max(ev_vals)

    result = {}
    for node in graph.nodes():
        pr_n = (pr[node] - pr_min) / (pr_max - pr_min) if pr_max > pr_min else 0.5
        ev_n = (ev[node] - ev_min) / (ev_max - ev_min) if ev_max > ev_min else 0.5
        result[node] = {"pr_norm": pr_n, "ev_norm": ev_n}

    return result


def score_scientific_influence(
    author: dict,
    graph,
    population_h_indices: list[float] | None = None,
    centrality_map: dict | None = None,
) -> float:
    """
    Blend PageRank + eigenvector centrality with h-index percentile.

    Graph centralities are min-max normalized across all nodes.
    h-index is percentile-ranked against the population.
    Final: 0.4 * pagerank_norm + 0.3 * eigenvector_norm + 0.3 * h_pct, scaled to 20.

    Args:
        centrality_map: Precomputed via precompute_centrality(). If None,
                        falls back to computing on the fly.
    """
    openalex_id = author.get("openalex_id", "")

    if centrality_map and openalex_id in centrality_map:
        pr_norm = centrality_map[openalex_id]["pr_norm"]
        ev_norm = centrality_map[openalex_id]["ev_norm"]
    elif graph is not None and graph.has_node(openalex_id):
        # Fallback: compute on the fly (slow for large graphs)
        cm = precompute_centrality(graph)
        pr_norm = cm[openalex_id]["pr_norm"]
        ev_norm = cm[openalex_id]["ev_norm"]
    else:
        pr_norm = 0.5
        ev_norm = 0.5

    # h-index percentile
    h = author.get("h_index", 0)
    if population_h_indices:
        h_pct = _percentile_rank(h, population_h_indices)
    else:
        # Solo scoring — use log-based estimate (h=45 is ~85th pct in medicine)
        h_pct = min(1.0, math.log1p(h) / math.log1p(100))

    raw = 0.4 * pr_norm + 0.3 * ev_norm + 0.3 * h_pct
    return _clamp(round(raw * 20, 2))


# ── Dimension 2: Clinical Alignment ──────────────────────────────────

def score_clinical_alignment(author: dict, config: dict) -> float:
    """
    Weighted percentage of config concepts matched by the author.

    Matches author concept display_names against config concept labels
    (case-insensitive substring). Each match contributes its config weight.
    Score = (sum of matched weights / sum of all weights) * 20.
    """
    target_concepts = config.get("openalex_concepts", [])
    if not target_concepts:
        return 10.0  # neutral if no config

    # Build searchable text from author concepts
    author_concept_text = " ".join(
        c.get("display_name", "") if isinstance(c, dict) else str(c)
        for c in author.get("concepts", [])
    ).lower()

    matched_weight = 0.0
    total_weight = 0.0

    for tc in target_concepts:
        w = tc.get("weight", 1.0)
        total_weight += w
        label = tc.get("label", "").lower()
        if label and label in author_concept_text:
            matched_weight += w

    if total_weight == 0:
        return 10.0

    ratio = matched_weight / total_weight
    return _clamp(round(ratio * 20, 2))


# ── Dimension 3: Reach & Visibility ──────────────────────────────────

def score_reach_visibility(author: dict) -> float:
    """
    Log-normalized citations (0-14 pts) + co-author institution diversity (0-6 pts).

    Citations: log10(citations) / log10(500000) * 14, capped at 14.
    Institutions: min(institution_count, 6) points.
    """
    citations = author.get("citation_count", 0)
    if citations > 0:
        # log10(500k) ≈ 5.7 — top-end normalizer
        cite_score = min(14.0, (math.log10(citations) / 5.7) * 14)
    else:
        cite_score = 0.0

    # Institution diversity from coauthor_institutions
    institutions = author.get("coauthor_institutions", [])
    inst_score = min(6.0, len(set(institutions)))

    return _clamp(round(cite_score + inst_score, 2))


# ── Dimension 4: Nutrition Openness ──────────────────────────────────

def score_nutrition_openness(author: dict, config: dict) -> float:
    """
    Neutral baseline (10) + 2 per nutrition keyword match, capped at 20.

    Searches work titles and concept names for keywords from config.
    """
    keywords = config.get("nutrition_keywords", [])
    if not keywords:
        return 10.0

    # Build searchable text from titles + concepts
    text_parts = list(author.get("recent_work_titles", []))
    for c in author.get("concepts", []):
        if isinstance(c, dict):
            text_parts.append(c.get("display_name", ""))
        else:
            text_parts.append(str(c))
    searchable = " ".join(text_parts).lower()

    matches = sum(1 for kw in keywords if kw.lower() in searchable)

    return _clamp(10.0 + (matches * 2))


# ── Dimension 5: Strategic Value ─────────────────────────────────────

def score_strategic_value(pharma_data: dict) -> float:
    """
    Inverse pharma entanglement: 20 - log-normalized payments.

    If no pharma data available, returns neutral 10.
    log10(payments) / log10(10_000_000) * 15, subtracted from 20.
    High pharma payments = lower strategic value for nutrition partnership.
    """
    if not pharma_data or not pharma_data.get("data_available"):
        return 10.0

    total = pharma_data.get("total_payments_usd")
    if total is None or total <= 0:
        return 18.0  # Data available but no/zero payments — very favorable

    # log10(10M) ≈ 7 — top-end normalizer
    entanglement = min(15.0, (math.log10(total) / 7.0) * 15)
    return _clamp(round(20.0 - entanglement, 2))


# ── Composite Scorer ─────────────────────────────────────────────────

def compute_ops_score(
    author: dict,
    pharma_data: dict,
    graph=None,
    config: dict | None = None,
    population_h_indices: list[float] | None = None,
    centrality_map: dict | None = None,
) -> dict:
    """
    Compute full OPS score for a single author.

    Args:
        centrality_map: Precomputed via precompute_centrality().

    Returns dict with composite score, subdimension scores, and tier.
    """
    if config is None:
        config = load_config()

    thresholds = config.get("tier_thresholds", {"A": 80, "B": 60, "C": 40})

    sci = score_scientific_influence(author, graph, population_h_indices, centrality_map)
    align = score_clinical_alignment(author, config)
    reach = score_reach_visibility(author)
    nutr = score_nutrition_openness(author, config)
    strat = score_strategic_value(pharma_data)

    composite = round(sci + align + reach + nutr + strat, 2)

    # Determine tier
    if composite >= thresholds["A"]:
        tier = "A"
    elif composite >= thresholds["B"]:
        tier = "B"
    elif composite >= thresholds["C"]:
        tier = "C"
    else:
        tier = "D"

    return {
        "ops_score": composite,
        "tier": tier,
        "scientific_influence_score": sci,
        "clinical_alignment_score": align,
        "reach_visibility_score": reach,
        "nutrition_openness_score": nutr,
        "strategic_value_score": strat,
    }


# ── CLI test harness ─────────────────────────────────────────────────

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    cfg = load_config()

    mock_author = {
        "openalex_id": "https://openalex.org/A0000000001",
        "display_name": "Dr. Jane Smith",
        "h_index": 45,
        "citation_count": 12000,
        "concepts": ["Type 2 diabetes", "Dietary intervention", "Obesity"],
        "recent_work_titles": [
            "Low carbohydrate diet in T2D management",
            "Ketogenic intervention outcomes",
        ],
        "coauthor_institutions": [
            "Harvard", "Mayo Clinic", "Stanford",
            "Johns Hopkins", "UCSF",
        ],
    }

    mock_pharma = {
        "total_payments_usd": 45000,
        "pharma_company_count": 3,
        "data_available": True,
    }

    print(f"Scoring: {mock_author['display_name']}")
    print(f"  h-index: {mock_author['h_index']}")
    print(f"  citations: {mock_author['citation_count']:,}")
    print(f"  concepts: {mock_author['concepts']}")
    print(f"  titles: {mock_author['recent_work_titles']}")
    print(f"  coauthor institutions: {mock_author['coauthor_institutions']}")
    print(f"  pharma payments: ${mock_pharma['total_payments_usd']:,.2f}")
    print()

    result = compute_ops_score(mock_author, mock_pharma, graph=None, config=cfg)

    print("=" * 50)
    print(f"  Scientific Influence:  {result['scientific_influence_score']:>6}/20")
    print(f"  Clinical Alignment:   {result['clinical_alignment_score']:>6}/20")
    print(f"  Reach & Visibility:   {result['reach_visibility_score']:>6}/20")
    print(f"  Nutrition Openness:   {result['nutrition_openness_score']:>6}/20")
    print(f"  Strategic Value:      {result['strategic_value_score']:>6}/20")
    print(f"  {'─' * 40}")
    print(f"  OPS COMPOSITE:        {result['ops_score']:>6}/100")
    print(f"  TIER:                     {result['tier']}")
    print("=" * 50)
