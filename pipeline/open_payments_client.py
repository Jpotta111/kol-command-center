"""
CMS Open Payments client — local parquet lookup.

Loads pre-downloaded CMS General Payment data from
data/cms_payments/payments.parquet (built by download_cms_data.py).
Lookups run in <100ms against the in-memory DataFrame.

Input: NPI number OR first_name + last_name.
Returns payment summary dict; never errors out on missing data.

To populate the parquet file:
    python -m pipeline.download_cms_data
"""

import logging
from pathlib import Path

import pandas as pd

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "cms_payments"
PARQUET_PATH = DATA_DIR / "payments.parquet"

# Module-level cache — loaded once on first call
_payments_df: pd.DataFrame | None = None


def _load_payments() -> pd.DataFrame | None:
    """Load parquet into memory on first call, cache for reuse."""
    global _payments_df

    if _payments_df is not None:
        return _payments_df

    if not PARQUET_PATH.exists():
        logger.warning(
            "Payments data not found at %s. "
            "Run: python -m pipeline.download_cms_data",
            PARQUET_PATH,
        )
        return None

    logger.info("Loading CMS payments from %s ...", PARQUET_PATH)
    _payments_df = pd.read_parquet(PARQUET_PATH)

    # Ensure name columns are uppercase strings for matching
    for col in ["covered_recipient_first_name", "covered_recipient_last_name"]:
        if col in _payments_df.columns:
            _payments_df[col] = _payments_df[col].fillna("").str.upper().str.strip()

    logger.info("Loaded %d payment records", len(_payments_df))
    return _payments_df


def _empty_result() -> dict:
    """Return a null-filled result for missing data."""
    return {
        "npi": None,
        "total_payments_usd": None,
        "pharma_company_count": None,
        "payment_years": [],
        "data_available": False,
    }


def lookup_payments(
    npi: str | None = None,
    first_name: str | None = None,
    last_name: str | None = None,
    years: list[int] | None = None,
) -> dict:
    """
    Look up pharma payments for a physician from local parquet data.

    Args:
        npi: NPI number (preferred lookup method).
        first_name: Physician first name (used if no NPI).
        last_name: Physician last name (used if no NPI).
        years: Filter to specific years. Defaults to all available.

    Returns:
        Dict with: npi, total_payments_usd, pharma_company_count,
        payment_years, data_available.
    """
    if not npi and not last_name:
        logger.warning("No NPI or name provided")
        return _empty_result()

    df = _load_payments()
    if df is None:
        return _empty_result()

    # Build filter mask
    if npi:
        mask = df["covered_recipient_npi"] == str(npi)
    else:
        mask = pd.Series(True, index=df.index)
        if last_name:
            mask &= df["covered_recipient_last_name"] == last_name.upper().strip()
        if first_name:
            # Match first token only — handles "JOANN" vs "JOANN E."
            first_upper = first_name.upper().strip()
            mask &= df["covered_recipient_first_name"].str.startswith(first_upper)

    # Filter by years if specified
    if years:
        year_strs = [str(y) for y in years]
        mask &= df["program_year"].isin(year_strs)

    matches = df[mask]

    if matches.empty:
        result = _empty_result()
        result["npi"] = npi
        return result

    # Aggregate
    total_usd = matches["total_amount_of_payment_usdollars"].sum()

    companies = set(
        matches["applicable_manufacturer_or_applicable_gpo_making_payment_name"]
        .dropna()
        .unique()
    )

    payment_years = sorted(
        int(y) for y in matches["program_year"].dropna().unique()
    )

    resolved_npi = npi
    if not resolved_npi:
        npi_vals = matches["covered_recipient_npi"].dropna()
        if not npi_vals.empty:
            resolved_npi = str(npi_vals.iloc[0])

    return {
        "npi": resolved_npi,
        "total_payments_usd": round(float(total_usd), 2),
        "pharma_company_count": len(companies),
        "payment_years": payment_years,
        "data_available": True,
    }


# ---------------------------------------------------------------------------
# CLI test harness
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import json as _json
    import time

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    # Test 1: Lookup by NPI
    print("Test 1: Lookup by NPI...")
    t0 = time.perf_counter()
    result = lookup_payments(npi="1821102930")
    t1 = time.perf_counter()
    print(_json.dumps(result, indent=2))
    print(f"  → {(t1-t0)*1000:.0f}ms\n")

    # Test 2: Lookup by name
    print("Test 2: Lookup by name (JOANN MANSON)...")
    t0 = time.perf_counter()
    result = lookup_payments(first_name="JOANN", last_name="MANSON")
    t1 = time.perf_counter()
    print(_json.dumps(result, indent=2))
    print(f"  → {(t1-t0)*1000:.0f}ms\n")

    # Test 3: Non-existent — graceful null
    print("Test 3: Non-existent physician...")
    t0 = time.perf_counter()
    result = lookup_payments(first_name="ZZZZNOTREAL", last_name="FAKENAME")
    t1 = time.perf_counter()
    print(_json.dumps(result, indent=2))
    print(f"  → {(t1-t0)*1000:.0f}ms\n")

    # Test 4: No input — graceful null
    print("Test 4: No input...")
    result = lookup_payments()
    print(_json.dumps(result, indent=2))

    # Test 5: Batch lookup speed
    print("\nTest 5: Batch lookup — 10 names...")
    names = [
        ("FRANK", "HU"), ("WALTER", "WILLETT"), ("JOANN", "MANSON"),
        ("DARIUSH", "MOZAFFARIAN"), ("NAVEED", "SATTAR"),
        ("ROB", "KNIGHT"), ("PAUL", "RIDKER"), ("RALPH", "DAGOSTINO"),
        ("SCOTT", "GRUNDY"), ("DAVID", "LUDWIG"),
    ]
    t0 = time.perf_counter()
    for first, last in names:
        lookup_payments(first_name=first, last_name=last)
    t1 = time.perf_counter()
    print(f"  10 lookups in {(t1-t0)*1000:.0f}ms ({(t1-t0)*100:.0f}ms avg)")
