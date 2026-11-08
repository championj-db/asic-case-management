"""Silver: first collapse event per company (target for the collapse model, SPEC 8.1).

DRGD dates are real (register deregistration date). P1 has no date for EXAD, so the external-administration date
is taken from the latest pre-collapse published notice (P7 is web-only, synthetic stand-in), falling back to the
first snapshot in which EXAD was observed.
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F


@dp.materialized_view(comment="First collapse (EXAD / DRGD) per ACN with its date and date source", cluster_by=["acn"])
@dp.expect_or_drop("has_collapse_date", "collapse_date IS NOT NULL")
def silver_company_collapse():
    hist = (spark.read.table("silver_company_status_history").filter("is_collapse")
            .groupBy("acn").agg(F.min_by("status", "valid_from").alias("collapse_status"),
                                F.min("valid_from").alias("history_date")))
    notices = spark.read.table("silver_published_notice").groupBy("acn").agg(F.max("notice_date").alias("notice_date"))
    exad = F.col("collapse_status") == "EXAD"
    return (hist.join(notices, "acn", "left")
            .withColumn("collapse_date", F.when(exad, F.coalesce("notice_date", "history_date")).otherwise(F.col("history_date")))
            .withColumn("date_source", F.when(exad & F.col("notice_date").isNotNull(), "published_notice_synthetic").otherwise("register"))
            .select("acn", "collapse_status", "collapse_date", "date_source"))
