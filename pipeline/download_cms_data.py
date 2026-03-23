"""
Download CMS Open Payments General Payment CSVs and extract to compact parquet.

Streams multi-GB CSVs in chunks, keeping only the columns needed for
pharma entanglement scoring. Output: data/cms_payments/payments.parquet

Usage:
    # Download from CMS and convert (slow — ~5GB per year):
    python -m pipeline.download_cms_data --years 2024

    # Or download CSVs first with curl, then convert locally (faster):
    curl -L -o data/cms_payments/2024_general.csv <URL>
    python -m pipeline.download_cms_data --from-local
"""

import argparse
import logging
import os
from pathlib import Path

import pandas as pd
import requests

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "cms_payments"

# CSV download URLs by year
CSV_URLS = {
    2024: "https://download.cms.gov/openpayments/PGYR2024_P01232026_01102026/OP_DTL_GNRL_PGYR2024_P01232026_01102026.csv",
    2023: "https://download.cms.gov/openpayments/PGYR2023_P01232026_01102026/OP_DTL_GNRL_PGYR2023_P01232026_01102026.csv",
    2022: "https://download.cms.gov/openpayments/PGYR2022_P01232026_01102026/OP_DTL_GNRL_PGYR2022_P01232026_01102026.csv",
}

# Only keep columns needed for scoring
KEEP_COLUMNS = [
    "Covered_Recipient_NPI",
    "Covered_Recipient_First_Name",
    "Covered_Recipient_Last_Name",
    "Recipient_State",
    "Total_Amount_of_Payment_USDollars",
    "Applicable_Manufacturer_or_Applicable_GPO_Making_Payment_Name",
    "Program_Year",
]

# Lowercase versions for matching against CSV headers
KEEP_COLUMNS_LOWER = [c.lower() for c in KEEP_COLUMNS]

CHUNK_SIZE = 100_000  # rows per chunk


def _process_csv_source(source: str, label: str, all_frames: list):
    """Process a CSV source (URL or local path) in chunks."""
    print(f"Processing {label}...")
    print(f"  Source: {source}")
    print(f"  (Reading in {CHUNK_SIZE}-row chunks)")

    try:
        chunks_processed = 0
        rows_kept = 0

        for chunk in pd.read_csv(
            source,
            chunksize=CHUNK_SIZE,
            usecols=lambda c: c.lower() in KEEP_COLUMNS_LOWER,
            dtype=str,
            on_bad_lines="skip",
            encoding="latin-1",
        ):
            chunk.columns = [c.lower() for c in chunk.columns]
            all_frames.append(chunk)
            chunks_processed += 1
            rows_kept += len(chunk)

            if chunks_processed % 10 == 0:
                print(f"  ... {rows_kept:,} rows processed")

        print(f"  done: {rows_kept:,} rows extracted")

    except Exception as e:
        logger.error("Failed to process %s: %s", label, e)
        print(f"  FAILED: {label} — {e}")


def download_and_extract(
    years: list[int] | None = None, from_local: bool = False
):
    """Download CSVs (or read local) and extract relevant columns to parquet."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    all_frames: list[pd.DataFrame] = []

    if from_local:
        # Read any CSV files already in data/cms_payments/
        csv_files = sorted(DATA_DIR.glob("*.csv"))
        if not csv_files:
            print(f"No CSV files found in {DATA_DIR}")
            print("Download first: curl -L -o data/cms_payments/2024_general.csv <URL>")
            return
        for csv_path in csv_files:
            _process_csv_source(str(csv_path), csv_path.name, all_frames)
    else:
        target_years = years or sorted(CSV_URLS.keys())
        for year in target_years:
            url = CSV_URLS.get(year)
            if not url:
                logger.warning("No URL for year %d, skipping", year)
                continue
            _process_csv_source(url, f"{year} General Payment data", all_frames)

    if not all_frames:
        print("No data downloaded. Check network and try again.")
        return

    print(f"\nCombining {len(all_frames)} chunks...")
    df = pd.concat(all_frames, ignore_index=True)

    # Normalize payment amounts to float
    df["total_amount_of_payment_usdollars"] = pd.to_numeric(
        df["total_amount_of_payment_usdollars"], errors="coerce"
    ).fillna(0.0)

    # Uppercase name columns for consistent matching
    for col in ["covered_recipient_first_name", "covered_recipient_last_name"]:
        df[col] = df[col].str.upper().str.strip()

    output_path = DATA_DIR / "payments.parquet"
    df.to_parquet(output_path, index=False)

    size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"\n✓ Saved: {output_path}")
    print(f"  {len(df):,} total rows, {size_mb:.1f} MB")
    print(f"  Years: {sorted(df['program_year'].dropna().unique())}")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    parser = argparse.ArgumentParser(description="Download CMS Open Payments data")
    parser.add_argument(
        "--years", type=int, nargs="+", default=None,
        help="Which years to download (default: all available)",
    )
    parser.add_argument(
        "--from-local", action="store_true",
        help="Process CSV files already in data/cms_payments/ instead of downloading",
    )
    args = parser.parse_args()

    download_and_extract(years=args.years, from_local=args.from_local)
