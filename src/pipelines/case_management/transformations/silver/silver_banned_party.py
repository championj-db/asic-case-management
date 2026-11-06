"""Silver: banned and disqualified persons and organisations (P4), latest snapshot.

Note (SPEC 9.1): a name match against this register does not prove identity; matches are reviewed (S5).
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F
from utilities.common import acn_from_abn_or_acn, latest_snapshot, norm_name, first_col


def _parties(table, party_type):
    df = latest_snapshot(spark.read.table(table))
    name = first_col(df, r"^bd_(per|org)_name$")
    return df.select(
        F.lit(party_type).alias("party_type"),
        F.trim(name).alias("name"),
        first_col(df, r"_type$").alias("ban_type"),
        first_col(df, r"_doc_num$").alias("document_no"),
        first_col(df, r"_start_dt$").alias("start_raw"),
        first_col(df, r"_end_dt$").alias("end_raw"),
        first_col(df, r"_add_local$").alias("locality"),
        first_col(df, r"_add_state$").alias("state"),
        first_col(df, r"_add_pcode$").alias("postcode"),
        first_col(df, r"^bd_org_acn$").alias("acn_raw"),
        "_snapshot")


@dp.materialized_view(comment="Banned / disqualified persons and organisations. provenance=public")
@dp.expect_or_drop("has_name", "name IS NOT NULL AND name <> ''")
def silver_banned_party():
    df = _parties("bronze_p04_asic_banned_persons", "person").unionByName(_parties("bronze_p04_asic_banned_orgs", "organisation"))
    parts = F.split("name", r",\s*")
    return (df
            .withColumn("start_date", F.expr("try_to_date(trim(start_raw), 'dd/MM/yyyy')"))
            .withColumn("end_date", F.expr("try_to_date(trim(end_raw), 'dd/MM/yyyy')"))
            .withColumn("family_name", F.when(F.col("party_type") == "person", F.initcap(F.trim(parts[0]))))
            .withColumn("given_names", F.when(F.col("party_type") == "person", F.initcap(F.trim(parts[1]))))
            .withColumn("acn", acn_from_abn_or_acn(F.col("acn_raw")))
            .withColumn("name_norm", norm_name(F.col("name")))
            .withColumn("is_current", F.col("end_date").isNull() | (F.col("end_date") > F.current_date()))
            .withColumn("banned_party_id", F.substring(F.sha2(F.concat_ws("|", "party_type", "name", "document_no", "start_raw"), 256), 1, 16))
            .drop("start_raw", "end_raw", "acn_raw")
            .withColumn("provenance", F.lit("public")))
