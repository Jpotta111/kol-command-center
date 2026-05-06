"""
OPS Scorer — Opportunity & Priority Score
The full scoring methodology is proprietary and not included
in this public repository.
This module provides the interface contract only.
Scoring dimensions and weights are configurable via config/ops_config.json.
To use this platform, implement your own scoring logic following
the interface below, or contact the maintainer for licensing information.
"""
def compute_ops_score(author, pharma_data=None, graph=None,
                      config=None, population_h_indices=None,
                      centrality_map=None, contact=None,
                      pubmed_data=None):
    """
    Compute a composite opportunity and priority score for a KOL.
    Returns a dict with keys:
      ops_score (int 0-100), tier (str A/B/C/D),
      and per-dimension scores defined in config.
    """
    raise NotImplementedError(
        "Full scoring methodology not included in public repo."
    )
def precompute_centrality(graph, config=None):
    """Precompute network centrality scores."""
    raise NotImplementedError(
        "Full scoring methodology not included in public repo."
    )
