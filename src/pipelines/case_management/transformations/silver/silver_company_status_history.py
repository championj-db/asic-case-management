"""Silver: company status history. Source of real collapse labels (REGD -> EXAD / DRGD, SPEC 8.1).

Built from (a) registration and deregistration dates in the register and (b) the first snapshot in which each
status was observed. History deepens as weekly snapshots accumulate.
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F, Window as W
from utilities.common import au_date


@dp.materialized_view(comment="Company status intervals (valid_from / valid_to) per ACN. provenance=public", cluster_by=["acn"])
def silver_company_status_history():
    b = (spark.read.table("bronze_p01_asic_companies").filter(F.col("current_name_indicator") == "Y")
         .withColumn("acn", F.lpad(F.trim("acn"), 9, "0")))
    registered = b.select("acn", F.lit("REGD").alias("status"), au_date("date_of_registration").alias("valid_from"), F.lit("register_date").alias("evidence"))
    deregistered = (b.select("acn", F.lit("DRGD").alias("status"), au_date("date_of_deregistration").alias("valid_from"), F.lit("register_date").alias("evidence"))
                    .filter("valid_from IS NOT NULL"))
    observed = (b.groupBy("acn", F.trim("status").alias("status"))
                .agg(F.min("_snapshot").alias("valid_from")).withColumn("evidence", F.lit("snapshot")))
    events = (registered.unionByName(deregistered).unionByName(observed).filter("valid_from IS NOT NULL")
              .groupBy("acn", "status").agg(F.min("valid_from").alias("valid_from"), F.min("evidence").alias("evidence")))
    w = W.partitionBy("acn").orderBy("valid_from")
    return (events.withColumn("valid_to", F.lead("valid_from").over(w))
                  .withColumn("is_collapse", F.col("status").isin("EXAD", "DRGD"))
                  .withColumn("provenance", F.lit("public")))
