"""Silver: current company register (P1), one row per ACN, whole register (millions of rows)."""
from pyspark import pipelines as dp
from pyspark.sql import functions as F, Window as W
from utilities.common import au_date, norm_name


@dp.materialized_view(comment="Current ASIC company register: one row per ACN from the latest snapshot. provenance=public",
                      cluster_by=["acn"])
@dp.expect_or_drop("valid_acn", "acn RLIKE '^[0-9]{9}$'")
@dp.expect("known_status", "status IN ('REGD', 'EXAD', 'SOFF', 'DRGD', 'NOAC', 'DISS', 'ADMN')")
def silver_company():
    w = W.partitionBy("acn").orderBy(F.desc("_snapshot"))
    return (spark.read.table("bronze_p01_asic_companies")
            .filter(F.col("current_name_indicator") == "Y")
            .withColumn("acn", F.lpad(F.trim("acn"), 9, "0"))
            .withColumn("_rn", F.row_number().over(w)).filter("_rn = 1")
            .select("acn",
                    F.nullif(F.trim("abn"), F.lit("")).alias("abn"),
                    F.trim("company_name").alias("company_name"),
                    norm_name(F.col("company_name")).alias("name_norm"),
                    F.trim("type").alias("type"), F.trim("class").alias("class"), F.trim("sub_class").alias("sub_class"),
                    F.trim("status").alias("status"),
                    au_date("date_of_registration").alias("reg_date"),
                    au_date("date_of_deregistration").alias("dereg_date"),
                    F.trim("previous_state_of_registration").alias("previous_state"),
                    F.col("_snapshot").alias("snapshot"), "provenance"))
