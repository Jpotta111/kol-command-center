"""
OPS (Outreach Prioritization Score) scorer — Medical Affairs edition.

Computes a 0-100 composite score across 5 dimensions (0-20 each):
  1. Institutional Credibility — AMC tier based on institution name
  2. Clinical Relevance       — PubMed MeSH term match ratio
  3. Collaboration Signal     — co-author flag, h-index+AMC, industry engagement
  4. Nutrition Openness       — keyword matches in titles/concepts
  5. Strategic Reach          — citations + h-index + AMC + pharma inverse

Inputs: author dict, pharma data dict, config dict, optional contact dict.
"""

import json
import logging
import math
from pathlib import Path
from urllib.parse import urlencode

import requests

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


# ── Institutional tier lists ────────────────────────────────────────────

TOP_AMC_KEYWORDS = [
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
]

MAJOR_SYSTEM_KEYWORDS = [
    "university hospital", "university medical", "medical school",
    "school of medicine", "college of medicine", "medical college",
    "teaching hospital", "academic medical", "health science",
    "national institutes of health", "nih", "cdc",
    "centers for disease", "veterans affairs", "va medical",
]


def is_top_amc(institution: str) -> bool:
    if not institution:
        return False
    lower = institution.lower()
    return any(kw in lower for kw in TOP_AMC_KEYWORDS)


def is_major_system(institution: str) -> bool:
    if not institution:
        return False
    lower = institution.lower()
    return any(kw in lower for kw in MAJOR_SYSTEM_KEYWORDS)


# ── Dimension 1: Institutional Credibility (0-20) ──────────────────────

def score_institutional_credibility(author: dict) -> float:
    inst = author.get("institution") or ""
    if is_top_amc(inst):
        h = author.get("h_index", 0)
        bonus = min(4, h // 25)
        return _clamp(16 + bonus)
    if is_major_system(inst):
        return _clamp(13)
    if inst:
        return _clamp(7)  # Regional/community
    return _clamp(3)  # Unknown/private practice


# ── Dimension 2: Clinical Relevance via PubMed (0-20) ──────────────────
# Per-paper MeSH + text word matching from fetched PubMed XML

PUBMED_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"

MESH_PRIMARY = [
    "Diabetes Mellitus, Type 2", "Diet, Ketogenic",
    "Diet, Carbohydrate-Restricted", "Insulin Resistance",
    "Glycated Hemoglobin", "Hypoglycemic Agents",
    "Blood Glucose", "Non-alcoholic Fatty Liver Disease",
]

MESH_SECONDARY = [
    "Obesity", "Weight Loss", "Dyslipidemias", "Triglycerides",
    "Hypertension", "C-Reactive Protein", "Cardiovascular Diseases",
    "Metabolic Syndrome", "Telemedicine", "Pancreatic Neoplasms",
    "Mental Disorders", "Depression", "Cognitive Dysfunction", "Fatty Liver",
]

TEXT_WORDS = [
    "nutritional ketosis", "carbohydrate restriction",
    "low carbohydrate", "low-carbohydrate", "continuous care",
    "diabetes reversal", "diabetes remission", "ketogenic diet",
    "MASLD", "MASH", "metabolic-associated steatotic",
    "metabolic-associated steatohepatitis", "NAFLD", "NASH",
    "pancreatic cancer", "metabolic psychiatry",
    "cognitive function", "brain health",
]

import re as _re
import time as _time
import xml.etree.ElementTree as _ET


def _pubmed_search(name: str, retmax: int = 50) -> dict:
    """Search PubMed, return {count, idlist}."""
    params = urlencode({
        "db": "pubmed", "term": f"{name}[Author]",
        "retmax": str(retmax), "retmode": "json",
    })
    resp = requests.get(f"{PUBMED_BASE}/esearch.fcgi?{params}", timeout=10)
    resp.raise_for_status()
    result = resp.json().get("esearchresult", {})
    return {
        "count": int(result.get("count", 0)),
        "idlist": result.get("idlist", []),
    }


def _pubmed_fetch_xml(pmids: list[str]) -> str:
    """Fetch PubMed article XML for given PMIDs."""
    if not pmids:
        return ""
    params = urlencode({"db": "pubmed", "id": ",".join(pmids), "retmode": "xml"})
    resp = requests.get(f"{PUBMED_BASE}/efetch.fcgi?{params}", timeout=15)
    resp.raise_for_status()
    return resp.text


def _extract_affiliation(xml_text: str) -> str | None:
    """Extract affiliation from first article in PubMed XML."""
    match = _re.search(r"<Affiliation>([^<]+)</Affiliation>", xml_text)
    return match.group(1).strip() if match else None


def _extract_mesh_terms(xml_text: str) -> list[str]:
    """Extract all MeSH DescriptorName values."""
    return _re.findall(r"<DescriptorName[^>]*>([^<]+)</DescriptorName>", xml_text)


def _extract_text_content(xml_text: str) -> str:
    """Extract all titles + abstract text for TIAB matching."""
    titles = _re.findall(r"<ArticleTitle>([^<]+)</ArticleTitle>", xml_text)
    abstracts = _re.findall(r"<AbstractText[^>]*>([^<]+)</AbstractText>", xml_text)
    return " ".join(titles + abstracts)


def pubmed_lookup(name: str) -> dict | None:
    """Full PubMed lookup: search + fetch XML + extract data."""
    search = _pubmed_search(name, retmax=10)
    if search["count"] == 0 or not search["idlist"]:
        return None

    _time.sleep(0.4)
    xml = _pubmed_fetch_xml(search["idlist"])

    return {
        "total_count": search["count"],
        "fetched_count": len(search["idlist"]),
        "affiliation": _extract_affiliation(xml),
        "mesh_terms": _extract_mesh_terms(xml),
        "text_content": _extract_text_content(xml),
    }


def score_clinical_relevance(author: dict, config: dict, pubmed_data: dict | None = None) -> float:
    """Score clinical relevance from PubMed MeSH/text data."""
    if pubmed_data is None:
        # Try live lookup
        name = author.get("display_name", "")
        if not name:
            return 5.0
        try:
            pubmed_data = pubmed_lookup(name)
        except Exception as e:
            logger.warning("PubMed lookup failed for %s: %s", name, e)
            return _fallback_clinical_relevance(author, config)

    if not pubmed_data or pubmed_data["fetched_count"] == 0:
        return _fallback_clinical_relevance(author, config)

    mesh_terms = pubmed_data["mesh_terms"]
    text_content = (pubmed_data.get("text_content") or "").lower()
    fetched = pubmed_data["fetched_count"]

    # Count primary MeSH hits
    primary_hits = sum(1 for m in mesh_terms if m in MESH_PRIMARY)
    # Count secondary MeSH hits
    secondary_hits = sum(1 for m in mesh_terms if m in MESH_SECONDARY)
    # Count text word hits
    text_hits = 0
    for tw in TEXT_WORDS:
        text_hits += len(_re.findall(_re.escape(tw.lower()), text_content))

    # Primary: up to 8 pts, secondary: up to 4 pts, text: up to 8 pts = 20 max
    # Multipliers tuned so a dedicated keto/T2D researcher scores 16-20
    primary_score = min(8.0, (primary_hits / fetched) * 20)
    secondary_score = min(4.0, (secondary_hits / fetched) * 12)
    text_score = min(8.0, (text_hits / fetched) * 16)

    return _clamp(round(primary_score + secondary_score + text_score, 2))


def _fallback_clinical_relevance(author: dict, config: dict) -> float:
    """OpenAlex concept matching fallback using same term set."""
    all_terms = [(t, 1.0) for t in MESH_PRIMARY] + [(t, 0.7) for t in MESH_SECONDARY]

    author_concept_text = " ".join(
        c.get("display_name", "") if isinstance(c, dict) else str(c)
        for c in author.get("concepts", [])
    ).lower()

    matched_weight = 0.0
    total_weight = 0.0
    for label, weight in all_terms:
        total_weight += weight
        if label.lower() in author_concept_text:
            matched_weight += weight

    if total_weight == 0:
        return 10.0
    return _clamp(round((matched_weight / total_weight) * 20, 2))


# ── Dimension 3: Collaboration Signal (0-20) ──────────────────────────

def score_collaboration_signal(
    author: dict, pharma_data: dict | None = None, contact: dict | None = None
) -> tuple[float, str]:
    """
    Returns (score, reason) tuple.
    Priority: co-author flag > top AMC + high h > pharma engaged > neutral.
    """
    contact = contact or {}

    # Check Virta Paper CoAuthor from CSV
    coauthor_flag = (
        contact.get("Virta Paper CoAuthor")
        or contact.get("virta_paper_coauthor")
        or contact.get("Virta Paper Coauthor")
        or ""
    ).lower()

    if coauthor_flag in ("true", "yes", "1"):
        return 20.0, "Virta Paper CoAuthor"

    h = author.get("h_index", 0)
    inst = author.get("institution") or ""

    if h > 30 and is_top_amc(inst):
        return 14.0, "Top AMC + high h-index"

    # Check pharma data for industry engagement
    if pharma_data and pharma_data.get("data_available"):
        total = pharma_data.get("total_payments_usd")
        if total is not None and total > 0:
            return 10.0, "Industry engaged (Open Payments)"

    return 8.0, "No signals detected"


# ── Dimension 4: Nutrition/Lifestyle Openness (0-20) ───────────────────

def score_nutrition_openness(
    author: dict, config: dict, collaboration_score: float = 0.0
) -> float:
    keywords = config.get("nutrition_keywords", [])
    if not keywords:
        return 10.0

    text_parts = list(author.get("recent_work_titles", []))
    for c in author.get("concepts", []):
        if isinstance(c, dict):
            text_parts.append(c.get("display_name", ""))
        else:
            text_parts.append(str(c))
    searchable = " ".join(text_parts).lower()

    matches = sum(1 for kw in keywords if kw.lower() in searchable)
    score = _clamp(10.0 + (matches * 2))

    # Co-authors are implicitly open — floor at 12
    if collaboration_score == 20.0 and score < 12.0:
        score = 12.0

    return score


# ── Dimension 5: Strategic Reach (0-20) ────────────────────────────────

def score_strategic_reach(author: dict, pharma_data: dict | None = None) -> float:
    score = 0.0
    citations = author.get("citation_count", 0)
    h = author.get("h_index", 0)
    inst = author.get("institution") or ""

    # Citation tiers
    if citations > 10_000:
        score += 8
    elif citations > 1_000:
        score += 5
    elif citations > 100:
        score += 3

    # h-index tiers
    if h > 50:
        score += 4
    elif h >= 20:
        score += 2

    # Top AMC bonus (intentional overlap with Dim 1)
    if is_top_amc(inst):
        score += 4

    # Pharma entanglement adjustment
    if pharma_data and pharma_data.get("data_available"):
        total = pharma_data.get("total_payments_usd")
        if total is not None:
            if total < 10_000:
                score += 4  # Low entanglement bonus
            elif total > 100_000:
                score -= 2  # High entanglement penalty

    return _clamp(round(score, 2))


# ── Composite Scorer ─────────────────────────────────────────────────

# Keep precompute_centrality for backward compat with pipeline.py
def precompute_centrality(graph) -> dict:
    """Precompute centrality metrics (kept for pipeline.py compat)."""
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


def compute_ops_score(
    author: dict,
    pharma_data: dict,
    graph=None,
    config: dict | None = None,
    population_h_indices: list[float] | None = None,
    centrality_map: dict | None = None,
    contact: dict | None = None,
    pubmed_data: dict | None = None,
) -> dict:
    """
    Compute full OPS score for a single author.

    Returns dict with composite score, subdimension scores, tier,
    and collaboration_reason.
    """
    if config is None:
        config = load_config()

    thresholds = config.get("tier_thresholds", {"A": 80, "B": 60, "C": 40})

    inst_cred = score_institutional_credibility(author)
    clin_rel = score_clinical_relevance(author, config, pubmed_data)
    collab_score, collab_reason = score_collaboration_signal(author, pharma_data, contact)
    nutr = score_nutrition_openness(author, config, collab_score)
    strat = score_strategic_reach(author, pharma_data)

    composite = round(inst_cred + clin_rel + collab_score + nutr + strat, 2)

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
        "institutional_credibility_score": inst_cred,
        "clinical_relevance_score": clin_rel,
        "collaboration_signal_score": collab_score,
        "collaboration_reason": collab_reason,
        "nutrition_openness_score": nutr,
        "strategic_reach_score": strat,
        # Legacy aliases for pipeline.py compatibility
        "scientific_influence_score": inst_cred,
        "clinical_alignment_score": clin_rel,
        "reach_visibility_score": collab_score,
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
        "institution": "Johns Hopkins University",
        "concepts": ["Type 2 diabetes", "Dietary intervention", "Obesity"],
        "recent_work_titles": [
            "Low carbohydrate diet in T2D management",
            "Ketogenic intervention outcomes",
        ],
    }

    mock_pharma = {
        "total_payments_usd": 5000,
        "pharma_company_count": 1,
        "data_available": True,
    }

    mock_contact = {"Virta Paper CoAuthor": "true"}

    print(f"Scoring: {mock_author['display_name']}")
    print(f"  Institution: {mock_author['institution']}")
    print(f"  h-index: {mock_author['h_index']}")
    print(f"  citations: {mock_author['citation_count']:,}")
    print(f"  Virta CoAuthor: {mock_contact['Virta Paper CoAuthor']}")
    print()

    result = compute_ops_score(
        mock_author, mock_pharma, graph=None, config=cfg, contact=mock_contact
    )

    print("=" * 50)
    print(f"  Institutional Credibility: {result['institutional_credibility_score']:>6}/20")
    print(f"  Clinical Relevance:       {result['clinical_relevance_score']:>6}/20")
    print(f"  Collaboration Signal:     {result['collaboration_signal_score']:>6}/20  ({result['collaboration_reason']})")
    print(f"  Nutrition Openness:       {result['nutrition_openness_score']:>6}/20")
    print(f"  Strategic Reach:          {result['strategic_reach_score']:>6}/20")
    print(f"  {'─' * 40}")
    print(f"  OPS COMPOSITE:            {result['ops_score']:>6}/100")
    print(f"  TIER:                         {result['tier']}")
    print("=" * 50)
