"""Gold: evidence text chunks for semantic search (SPEC 8.4 step 3). Source of the Vector Search Delta Sync index
built by notebook 06, so Change Data Feed is enabled. Streaming: each parsed document is chunked once.
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F

CHUNK_CHARS, STRIDE = 1200, 1000  # ~200 characters of overlap between consecutive chunks


@dp.table(comment="Evidence chunks (chunk_id primary key) for the evidence_chunks_index Vector Search index",
          table_properties={"delta.enableChangeDataFeed": "true"})
@dp.expect_or_drop("non_empty_chunk", "length(trim(chunk_text)) > 0")
def gold_evidence_chunks():
    manifest = spark.read.table("silver_evidence_manifest").select("evidence_id", "doc_type", "source_system", "provenance")
    chunks = F.expr(f"transform(sequence(0, greatest(cast(ceil(length(parsed_text) / {STRIDE}.0) AS INT) - 1, 0)), "
                    f"i -> substring(parsed_text, i * {STRIDE} + 1, {CHUNK_CHARS}))")
    return (spark.readStream.table("silver_evidence_parsed").filter("parse_ok AND parsed_text IS NOT NULL")
            .select("evidence_id", "case_id", F.posexplode(chunks).alias("chunk_index", "chunk_text"))
            .join(manifest, "evidence_id", "left")
            .withColumn("chunk_id", F.concat_ws("-", "evidence_id", F.lpad(F.col("chunk_index").cast("string"), 4, "0"))))
