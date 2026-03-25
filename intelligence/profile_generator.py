"""
Gemini-powered KOL profile generator.

Reads a KOL node from kol_graph.json, enriches it with recent work titles
from OpenAlex, then calls Gemini 2.0 Flash to produce a structured
intelligence profile for Medical Affairs outreach.

Usage:
    python -m intelligence.profile_generator              # top 10
    python -m intelligence.profile_generator -n 5         # top 5
    python -m intelligence.profile_generator --author "Frank B. Hu"  # single
"""

import json
import logging
import os
import time
from pathlib import Path
from urllib.parse import urlencode

from google import genai
from google.genai import types
import requests
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

# Load .env if present (GEMINI_API_KEY, etc.)
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
GRAPH_PATH = DATA_DIR / "kol_graph.json"
PROFILES_PATH = DATA_DIR / "kol_profiles.json"

GEMINI_MODEL = "gemini-2.0-flash"
RATE_LIMIT_DELAY = 2  # seconds between Gemini calls

# Module-level client — initialized once
_client: genai.Client | None = None


def _get_client() -> genai.Client:
    """Get or create the Gemini API client."""
    global _client
    if _client is not None:
        return _client

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "GEMINI_API_KEY not set. Get one at https://aistudio.google.com"
        )
    _client = genai.Client(api_key=api_key)
    return _client


def _fetch_work_titles(openalex_id: str, n: int = 20) -> list[str]:
    """Fetch recent work titles from OpenAlex for a single author."""
    short_id = openalex_id.replace("https://openalex.org/", "")
    params = {
        "filter": f"authorships.author.id:{short_id}",
        "per_page": n,
        "select": "id,title,publication_year",
        "sort": "publication_year:desc",
        "mailto": "kol-pipeline@example.com",
    }
    url = f"https://api.openalex.org/works?{urlencode(params)}"

    try:
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        works = resp.json().get("results", [])
        return [w["title"] for w in works if w.get("title")]
    except requests.exceptions.RequestException as e:
        logger.warning("Failed to fetch works for %s: %s", openalex_id, e)
        return []


def _build_prompt(kol: dict, work_titles: list[str]) -> str:
    """Build the Gemini prompt for a single KOL profile."""
    titles_block = "\n".join(f"  - {t}" for t in work_titles[:20]) if work_titles else "  (no recent titles available)"

    pharma_note = ""
    sv = kol.get("strategic_value_score", 10.0)
    if sv >= 15:
        pharma_note = "Low or no pharma industry payments detected."
    elif sv <= 8:
        pharma_note = "Significant pharma industry financial relationships detected."
    else:
        pharma_note = "Moderate or unknown pharma industry relationships."

    return f"""You are an intelligence analyst for a Medical Affairs team at a company that reverses Type 2 diabetes through nutrition-first, low-carbohydrate dietary intervention (similar to Virta Health's approach).

Analyze this Key Opinion Leader and produce a structured intelligence profile.

## KOL Data
- Name: {kol['display_name']}
- Institution: {kol.get('institution', 'Unknown')}
- h-index: {kol.get('h_index', 'N/A')}
- Total citations: {kol.get('citation_count', 'N/A'):,}
- OPS Score: {kol.get('ops_score', 'N/A')}/100 (Tier {kol.get('tier', '?')})
- Scientific Influence: {kol.get('scientific_influence_score', 'N/A')}/20
- Clinical Alignment: {kol.get('clinical_alignment_score', 'N/A')}/20
- Reach & Visibility: {kol.get('reach_visibility_score', 'N/A')}/20
- Nutrition Openness: {kol.get('nutrition_openness_score', 'N/A')}/20
- Strategic Value: {kol.get('strategic_value_score', 'N/A')}/20
- Pharma note: {pharma_note}

## Recent Publications (most recent first)
{titles_block}

## Instructions
Respond with ONLY a valid JSON object (no markdown, no code fences) with these exact keys:

{{
  "summary": "2-3 sentence executive overview of who this person is and why they matter",
  "scientific_positioning": "Their role and reputation in the field — what are they known for?",
  "nutrition_stance_assessment": {{
    "level": "LOW|MEDIUM|HIGH",
    "reasoning": "1-2 sentences explaining why you assessed this level of openness to nutrition-first approaches"
  }},
  "key_papers": [
    {{
      "title": "paper title from the list above",
      "relevance": "one sentence on why this paper matters for nutrition-first diabetes reversal outreach"
    }}
  ],
  "outreach_angle": "Specific recommended first-contact angle tailored to their work — NOT generic. Reference a specific paper or research theme.",
  "sme_briefing": "3 sentences max — what a field medical team member needs to know before a meeting or mention of this person",
  "red_flags": ["list of concerns: high pharma entanglement, public skepticism of dietary intervention, institutional conflicts, etc. Empty list if none."],
  "tier_rationale": "Plain English explanation of why they scored Tier {kol.get('tier', '?')} ({kol.get('ops_score', 'N/A')}/100)"
}}

key_papers should contain exactly 3 entries. Pick the 3 most relevant to nutrition-first diabetes reversal from the publications list. If none are directly relevant, pick the 3 closest and note why they're adjacent.
"""


def _generate_profile_impl(kol: dict) -> dict:
    """Core profile generation — may raise on API/config errors."""
    client = _get_client()

    # Enrich with recent work titles
    work_titles = _fetch_work_titles(kol["openalex_id"])

    prompt = _build_prompt(kol, work_titles)

    try:
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                temperature=0.3,
                max_output_tokens=2048,
            ),
        )
        raw_text = response.text.strip()

        # Strip markdown code fences if present
        if raw_text.startswith("```"):
            raw_text = raw_text.split("\n", 1)[1]
            if raw_text.endswith("```"):
                raw_text = raw_text[:-3].strip()

        profile = json.loads(raw_text)
        profile["_meta"] = {
            "openalex_id": kol["openalex_id"],
            "display_name": kol["display_name"],
            "ops_score": kol.get("ops_score"),
            "tier": kol.get("tier"),
            "model": GEMINI_MODEL,
        }
        return profile

    except json.JSONDecodeError as e:
        logger.error("Failed to parse Gemini response for %s: %s", kol["display_name"], e)
        logger.debug("Raw response: %s", raw_text[:500])
        return {
            "_error": f"JSON parse failed: {e}",
            "_raw": raw_text[:1000],
            "_meta": {
                "openalex_id": kol["openalex_id"],
                "display_name": kol["display_name"],
            },
        }
    except Exception as e:
        logger.error("Gemini call failed for %s: %s", kol["display_name"], e)
        return {
            "_error": str(e),
            "_meta": {
                "openalex_id": kol["openalex_id"],
                "display_name": kol["display_name"],
            },
        }


def generate_profile(kol: dict) -> dict:
    """Public wrapper with top-level error handling."""
    try:
        return _generate_profile_impl(kol)
    except Exception as e:
        logger.error("Profile generation failed for %s: %s", kol.get("display_name", "?"), e)
        return {
            "_error": str(e),
            "_meta": {
                "openalex_id": kol.get("openalex_id", ""),
                "display_name": kol.get("display_name", ""),
            },
        }


def batch_profile(n: int = 10, author_name: str | None = None):
    """
    Profile top N KOLs from kol_graph.json (or a single author by name).

    Writes results to data/kol_profiles.json.
    """
    if not GRAPH_PATH.exists():
        print(f"Graph not found at {GRAPH_PATH}")
        print("Run the pipeline first: python -m pipeline.pipeline -n 20")
        return

    with open(GRAPH_PATH) as f:
        graph = json.load(f)

    nodes = graph["nodes"]

    if author_name:
        targets = [
            node for node in nodes
            if author_name.lower() in node["display_name"].lower()
        ]
        if not targets:
            print(f"No author matching '{author_name}' found in graph.")
            return
    else:
        # Sort by OPS score descending, take top N
        targets = sorted(nodes, key=lambda x: x.get("ops_score", 0), reverse=True)[:n]

    print(f"Profiling {len(targets)} KOLs with Gemini {GEMINI_MODEL}...\n")

    profiles = []
    for i, kol in enumerate(targets, 1):
        name = kol["display_name"]
        score = kol.get("ops_score", "?")
        tier = kol.get("tier", "?")

        print(f"[{i}/{len(targets)}] {name} (OPS {score}, Tier {tier})")

        profile = generate_profile(kol)
        profiles.append(profile)

        if "_error" in profile:
            print(f"  ERROR: {profile['_error']}\n")
        else:
            summary = profile.get("summary", "")
            angle = profile.get("outreach_angle", "")
            stance = profile.get("nutrition_stance_assessment", {})
            level = stance.get("level", "?") if isinstance(stance, dict) else "?"

            print(f"  Nutrition stance: {level}")
            print(f"  Summary: {summary[:120]}...")
            print(f"  Outreach: {angle[:120]}...")
            print()

        # Rate limiting between Gemini calls
        if i < len(targets):
            time.sleep(RATE_LIMIT_DELAY)

    # Write output
    PROFILES_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(PROFILES_PATH, "w") as f:
        json.dump(profiles, f, indent=2)

    print(f"\nProfiles written to {PROFILES_PATH}")
    return profiles


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    parser = argparse.ArgumentParser(description="Generate KOL intelligence profiles")
    parser.add_argument(
        "-n", type=int, default=10,
        help="Number of top KOLs to profile (default: 10)",
    )
    parser.add_argument(
        "--author", type=str, default=None,
        help="Profile a single author by name (substring match)",
    )
    args = parser.parse_args()

    # Startup diagnostics
    env_path = Path(__file__).resolve().parent.parent / ".env"
    api_key = os.environ.get("GEMINI_API_KEY")
    print(f"KOL Profile Generator")
    print(f"  Graph:   {GRAPH_PATH}")
    print(f"  .env:    {env_path} ({'found' if env_path.exists() else 'NOT FOUND'})")
    print(f"  GEMINI_API_KEY: {'set (' + str(len(api_key)) + ' chars)' if api_key else 'NOT SET'}")
    print(f"  OPENALEX_EMAIL: {os.environ.get('OPENALEX_EMAIL', 'NOT SET')}")

    if not GRAPH_PATH.exists():
        print(f"\n  ERROR: {GRAPH_PATH} not found.")
        print(f"  Run the pipeline first:")
        print(f"    python -m pipeline.pipeline -n 20 --skip-payments")
        raise SystemExit(1)

    if GRAPH_PATH.stat().st_size == 0:
        print(f"\n  ERROR: {GRAPH_PATH} is empty (0 bytes).")
        print(f"  Re-run the pipeline to regenerate it.")
        raise SystemExit(1)

    print()
    batch_profile(n=args.n, author_name=args.author)
