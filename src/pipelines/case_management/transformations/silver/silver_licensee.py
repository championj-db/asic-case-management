"""Silver: AFS and credit licensees (P3), latest snapshot, linked to companies by ACN."""
from pyspark import pipelines as dp
from pyspark.sql import functions as F
from utilities.common import au_date, acn_from_abn_or_acn, latest_snapshot


@dp.materialized_view(comment="AFS and credit licences with holder ACN/ABN. provenance=public")
@dp.expect_or_drop("has_licence_no", "licence_no IS NOT NULL")
def silver_licensee():
    afs = (latest_snapshot(spark.read.table("bronze_p03_asic_afs_licensees"))
           .select(F.trim("afs_lic_num").alias("licence_no"), F.lit("AFS").alias("licence_type"),
                   F.trim("afs_lic_name").alias("holder_name"), F.col("afs_lic_abn_acn").alias("abn_acn"),
                   F.lit(None).cast("string").alias("status"),
                   au_date("afs_lic_start_dt").alias("start_date"), F.lit(None).cast("date").alias("end_date"),
                   F.trim("afs_lic_add_state").alias("state"), F.col("afs_lic_condition").alias("authorisations"), "_snapshot"))
    credit = (latest_snapshot(spark.read.table("bronze_p03_asic_credit_licensees"))
              .select(F.trim("cred_lic_num").alias("licence_no"), F.lit("Credit").alias("licence_type"),
                      F.trim("cred_lic_name").alias("holder_name"), F.col("cred_lic_abn_acn").alias("abn_acn"),
                      F.trim("cred_lic_status").alias("status"),
                      au_date("cred_lic_start_dt").alias("start_date"), au_date("cred_lic_end_dt").alias("end_date"),
                      F.trim("cred_lic_state").alias("state"), F.col("cred_lic_authorisations").alias("authorisations"), "_snapshot"))
    digits = F.regexp_replace("abn_acn", "[^0-9]", "")
    return (afs.unionByName(credit)
            .withColumn("acn", acn_from_abn_or_acn(F.col("abn_acn")))
            .withColumn("abn", F.when(F.length(digits) == 11, digits))
            .withColumn("is_ceased", F.col("end_date").isNotNull() & (F.col("end_date") <= F.current_date()))
            .withColumn("provenance", F.lit("public")))
