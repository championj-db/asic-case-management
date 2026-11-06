"""Shared helpers for the asic-case-management pipeline.

All locations and endpoints come from pipeline configuration (set by the bundle), never hard-coded.
"""
import re
from pyspark.sql import SparkSession, DataFrame, functions as F


def _spark():
    return SparkSession.getActiveSession()


def conf(key, default=None):
    value = _spark().conf.get(key, default)
    if value is None:
        raise ValueError(f"pipeline configuration '{key}' is required")
    return value


def raw_path(*parts):
    return "/".join([conf("raw_volume_path").rstrip("/"), *parts])


def evidence_path():
    return conf("evidence_volume_path").rstrip("/")


def llm_endpoint():
    return conf("llm_endpoint")


def snake(name):
    """'\ufeffDate of Registration' -> 'date_of_registration' (Delta-safe column names)."""
    return re.sub(r"[^0-9a-z]+", "_", name.replace("\ufeff", "").strip().lower()).strip("_")


def snake_cols(df: DataFrame) -> DataFrame:
    return df.toDF(*[c if c.startswith("_") else snake(c) for c in df.columns])


def with_file_lineage(df: DataFrame, provenance: str) -> DataFrame:
    """Adds source file, snapshot (from .../snapshot=<yyyymmdd>/...), ingest time and provenance."""
    return (df.withColumn("_source_file", F.col("_metadata.file_path"))
              .withColumn("_snapshot", F.expr(r"try_to_date(regexp_extract(_metadata.file_path, 'snapshot=([0-9]{8})', 1), 'yyyyMMdd')"))
              .withColumn("_ingested_at", F.current_timestamp())
              .withColumn("provenance", F.lit(provenance)))


def first_col(df: DataFrame, pattern: str):
    """First column whose name matches a regex (for registers whose prefixes differ, e.g. bd_per_* vs bd_org_*)."""
    for c in df.columns:
        if re.search(pattern, c):
            return F.col(c)
    return F.lit(None).cast("string")


def au_date(col_name: str):
    """ASIC registers use dd/MM/yyyy; malformed values become null instead of failing."""
    return F.expr(f"try_to_date(trim(`{col_name}`), 'dd/MM/yyyy')")


def acn_from_abn_or_acn(col):
    """Company ABNs end in the 9-digit ACN; 9-digit inputs are already ACNs."""
    digits = F.regexp_replace(col, "[^0-9]", "")
    return F.when(F.length(digits) >= 9, F.substring(F.lpad(digits, 11, "0"), -9, 9))


def latest_snapshot(df: DataFrame) -> DataFrame:
    """Keep only rows from the most recent weekly snapshot of a register."""
    return df.join(df.agg(F.max("_snapshot").alias("_snapshot")), "_snapshot")


def norm_name(col):
    """Upper-case, strip punctuation and company suffixes for matching."""
    n = F.upper(F.regexp_replace(col, r"[^A-Za-z0-9 ]", " "))
    n = F.regexp_replace(n, r"\b(PTY|LTD|LIMITED|PROPRIETARY|THE|CO|INC)\b", " ")
    return F.trim(F.regexp_replace(n, r"\s+", " "))
