"""Silver: one row per suggested extraction (entity / amount / date / account / event) for human review (SPEC 8.4)."""
from pyspark import pipelines as dp
from pyspark.sql import functions as F


def _rows(df, kind, array_col, value_expr, span_expr, event_date_expr=None):
    x = df.select("evidence_id", "case_id", "ai_model", "ai_generated_at", F.explode(f"extraction.{array_col}").alias("x"))
    return x.select("evidence_id", "case_id", F.lit(kind).alias("kind"),
                    F.expr(value_expr).cast("string").alias("value"), F.expr(span_expr).alias("span"),
                    (F.expr(event_date_expr) if event_date_expr else F.lit(None).cast("string")).alias("event_date_raw"),
                    F.col("ai_model").alias("model"), F.col("ai_generated_at").alias("generated_at"))


@dp.materialized_view(comment="Suggested extractions per evidence item (status suggested until a reviewer confirms/rejects in the app)")
@dp.expect_or_drop("has_value", "value IS NOT NULL AND value <> ''")
def silver_evidence_extraction():
    ai = spark.read.table("silver_evidence_ai").filter("ai_error IS NULL")
    rows = (_rows(ai, "entity_person", "people", "x", "CAST(NULL AS STRING)")
            .unionByName(_rows(ai, "entity_company", "companies", "x", "CAST(NULL AS STRING)"))
            .unionByName(_rows(ai, "account", "accounts", "x", "CAST(NULL AS STRING)"))
            .unionByName(_rows(ai, "amount", "amounts", "x.value", "x.context"))
            .unionByName(_rows(ai, "date", "dates", "x.date", "x.context", "x.date"))
            .unionByName(_rows(ai, "event", "events", "concat(x.event_type, ': ', x.description)", "x.description", "x.date")))
    return (rows.withColumn("event_date", F.expr("try_to_date(event_date_raw)")).drop("event_date_raw")
            .withColumn("extraction_id", F.substring(F.sha2(F.concat_ws("|", "evidence_id", "kind", "value", "span"), 256), 1, 16))
            .withColumn("status", F.lit("suggested"))
            .withColumn("reviewer", F.lit(None).cast("string"))
            .withColumn("ai_flag", F.lit(True))
            .dropDuplicates(["extraction_id"]))
