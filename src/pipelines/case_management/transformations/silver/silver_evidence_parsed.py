"""Silver: evidence text extracted with ai_parse_document (SPEC 8.4 step 2). Streaming: each file is parsed once."""
from pyspark import pipelines as dp
from pyspark.sql import functions as F


@dp.table(comment="Parsed evidence documents: ai_parse_document VARIANT, flattened text, page count, parse status")
@dp.expect("parsed_ok", "parse_ok")
def silver_evidence_parsed():
    return (spark.readStream.table("bronze_evidence_files")
            .withColumn("parsed", F.expr("ai_parse_document(content, map('version', '2.0'))"))
            .select("evidence_id", "case_id", "path", "file_name", "sha256", "length", "_ingested_at", "parsed",
                    F.expr("is_variant_null(parsed:error_status)").alias("parse_ok"),
                    F.expr("concat_ws('\\n\\n', transform(try_cast(parsed:document:elements AS ARRAY<VARIANT>), "
                           "e -> try_cast(e:content AS STRING)))").alias("parsed_text"),
                    F.expr("size(try_cast(parsed:document:pages AS ARRAY<VARIANT>))").alias("page_count"),
                    F.current_timestamp().alias("parsed_at")))
