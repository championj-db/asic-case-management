"""Gold: evidence items and chain of custody (SPEC 9 'evidence_item', 'custody_event'; SPEC 10 chain of custody)."""
from pyspark import pipelines as dp
from pyspark.sql import functions as F


@dp.materialized_view(comment="Evidence items with ingest hash, hash verification against the manifest, and AI summary (AI-labelled)")
@dp.expect("hash_verified", "hash_verified")
def gold_evidence_item():
    files = spark.read.table("bronze_evidence_files").select("evidence_id", "sha256", F.col("_ingested_at").alias("ingested_at"), "length")
    ai = spark.read.table("silver_evidence_ai").select("evidence_id", F.col("extraction.summary").alias("ai_summary"), "ai_model", "ai_generated_at")
    # Parsed text (null bytes removed) so the app's viewer can render and highlight extraction spans
    text = spark.read.table("silver_evidence_parsed").select(
        "evidence_id", F.regexp_replace("parsed_text", "\\x00", "").alias("parsed_text"), "page_count")
    return (spark.read.table("silver_evidence_manifest")
            .join(files, "evidence_id", "left").join(ai, "evidence_id", "left").join(text, "evidence_id", "left")
            .select("evidence_id", "case_id", "filename", "doc_type", "sha256", "sha256_at_creation",
                    (F.col("sha256") == F.col("sha256_at_creation")).alias("hash_verified"),
                    F.col("source_system").alias("source"), "custodian", "document_date", "ingested_at", F.col("length").alias("bytes"),
                    "ai_summary", "ai_model", "ai_generated_at", F.col("ai_summary").isNotNull().alias("ai_flag"),
                    "source_citation", "parsed_text", "page_count", "provenance"))


@dp.materialized_view(comment="Append-style custody log: created, ingested, parsed, AI-extracted (hash after each step)")
def gold_custody_event():
    m = spark.read.table("silver_evidence_manifest").select(
        "evidence_id", F.col("custodian").alias("actor"), F.lit("created").alias("action"),
        F.col("document_date").alias("event_ts"), F.col("sha256_at_creation").alias("hash_after"))
    i = spark.read.table("bronze_evidence_files").select(
        "evidence_id", F.lit("pipeline").alias("actor"), F.lit("ingested").alias("action"),
        F.col("_ingested_at").alias("event_ts"), F.col("sha256").alias("hash_after"))
    p = spark.read.table("silver_evidence_parsed").select(
        "evidence_id", F.lit("ai_parse_document").alias("actor"), F.lit("parsed").alias("action"),
        F.col("parsed_at").alias("event_ts"), F.col("sha256").alias("hash_after"))
    a = spark.read.table("silver_evidence_ai").select(
        "evidence_id", F.col("ai_model").alias("actor"), F.lit("ai_extracted").alias("action"),
        F.col("ai_generated_at").alias("event_ts"), F.col("sha256").alias("hash_after"))
    return (m.unionByName(i).unionByName(p).unionByName(a)
            .withColumn("custody_event_id", F.substring(F.sha2(F.concat_ws("|", "evidence_id", "action", "event_ts"), 256), 1, 16))
            .withColumn("provenance", F.lit("synthetic")))
