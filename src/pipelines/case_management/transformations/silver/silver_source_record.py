"""Silver: source records linked to resolved entities, with match score (SPEC 4 'Source record', 9 'source_record').

Every number shown in Entity 360 can be traced back to one of these rows.
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F


def _rec(df, entity_expr, agency, source_table, key_expr, score=1.0, score_col=None):
    return df.select(F.expr(entity_expr).alias("entity_id"), F.lit(agency).alias("agency"), F.lit(source_table).alias("source_table"),
                     F.expr(key_expr).cast("string").alias("source_key"),
                     (F.col(score_col) if score_col else F.lit(score)).cast("double").alias("match_score"))


@dp.materialized_view(comment="Entity <-> source record links with match_score (>= 0.9 auto-merged)")
@dp.expect_all_or_drop({"has_entity": "entity_id IS NOT NULL", "has_key": "source_key IS NOT NULL"})
def silver_source_record():
    slice_acns = spark.read.table("silver_curated_slice").select("acn")
    co = "concat('CO-', acn)"
    t = spark.read.table
    parts = [
        _rec(t("silver_company").join(slice_acns, "acn"), co, "ASIC", "silver_company", "acn"),
        _rec(t("silver_licensee").join(slice_acns, "acn"), co, "ASIC", "silver_licensee", "licence_no"),
        _rec(t("silver_banned_party").filter("acn IS NOT NULL").join(slice_acns, "acn"), co, "ASIC", "silver_banned_party", "banned_party_id"),
        _rec(t("silver_abn_register").filter("acn IS NOT NULL").join(slice_acns, "acn"), co, "ABR", "silver_abn_register", "abn"),
        _rec(t("silver_ato_profile").select("acn").distinct(), co, "ATO", "silver_ato_profile", "acn"),
        _rec(t("silver_austrac_smr"), co, "AUSTRAC", "silver_austrac_smr", "smr_id"),
        _rec(t("silver_apra_flag").select("acn").distinct(), co, "APRA", "silver_apra_flag", "acn"),
        _rec(t("silver_afca_complaints").select("acn").distinct(), co, "AFCA", "silver_afca_complaints", "acn"),
        _rec(t("silver_breach_report"), co, "ASIC", "silver_breach_report", "intake_id"),
        _rec(t("silver_directorship"), "concat('PE-', person_id)", "ASIC", "silver_directorship", "directorship_id"),
        _rec(t("person_banned_match_candidates").filter("match_score >= 0.9"), "entity_id", "ASIC", "silver_banned_party",
             "banned_party_id", score_col="match_score"),
    ]
    out = parts[0]
    for p in parts[1:]:
        out = out.unionByName(p)
    return (out.withColumn("source_record_id", F.substring(F.sha2(F.concat_ws("|", "entity_id", "source_table", "source_key"), 256), 1, 20))
               .withColumn("loaded_at", F.current_timestamp())
               .dropDuplicates(["source_record_id"]))
