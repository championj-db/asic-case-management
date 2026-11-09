"""Silver: source records linked to resolved entities, with match score (SPEC 4 'Source record', 9 'source_record').

Every number shown in Entity 360 can be traced back to one of these rows.
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F


# Source catalogue id (SPEC 9.1) and provenance per source table, so every record traces to a listed source.
SOURCE_OF = {
    "silver_company": ("P1", "public"), "silver_licensee": ("P3", "public"), "silver_banned_party": ("P4", "public"),
    "bronze_p02_asic_business_names": ("P2", "public"), "silver_abn_register": ("P11", "public"),
    "silver_ato_tax_transparency": ("P12", "public"), "silver_ato_profile": ("S1", "synthetic"), "silver_austrac_smr": ("S2", "synthetic"),
    "silver_apra_flag": ("S3", "synthetic"), "silver_afca_complaints": ("S3", "synthetic"), "silver_directorship": ("S4", "synthetic"),
    "silver_breach_report": ("S5", "synthetic"),
}


def _rec(df, entity_expr, agency, source_table, key_expr, score=1.0, score_col=None):
    source_id, provenance = SOURCE_OF[source_table]
    return df.select(F.expr(entity_expr).alias("entity_id"), F.lit(agency).alias("agency"), F.lit(source_table).alias("source_table"),
                     F.expr(key_expr).cast("string").alias("source_key"),
                     (F.col(score_col) if score_col else F.lit(score)).cast("double").alias("match_score"),
                     F.lit(source_id).alias("source_id"), F.lit(provenance).alias("provenance"))


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
        # Business names held by the company's ABN (exact identifier match, so no probabilistic linking)
        _rec(t("bronze_p02_asic_business_names").select(F.trim("bn_abn").alias("abn"), F.trim("bn_name").alias("bn_name"))
             .join(t("silver_company").join(slice_acns, "acn").select("acn", "abn"), "abn"), co, "ASIC", "bronze_p02_asic_business_names", "bn_name"),
        # ATO Corporate Tax Transparency (public) for large corporates, matched on ABN
        _rec(t("silver_ato_tax_transparency").select("abn", "income_year").join(t("silver_company").join(slice_acns, "acn").select("acn", "abn"), "abn"),
             co, "ATO", "silver_ato_tax_transparency", "concat(abn, ':', income_year)"),
        _rec(t("silver_ato_profile").select("acn").distinct(), co, "ATO", "silver_ato_profile", "acn"),
        _rec(t("silver_austrac_smr"), co, "AUSTRAC", "silver_austrac_smr", "smr_id"),
        _rec(t("silver_apra_flag").select("acn").distinct(), co, "APRA", "silver_apra_flag", "acn"),
        _rec(t("silver_afca_complaints").select("acn").distinct(), co, "AFCA", "silver_afca_complaints", "acn"),
        _rec(t("silver_breach_report"), co, "ASIC", "silver_breach_report", "intake_id"),
        _rec(t("silver_directorship"), "concat('PE-', person_id)", "ASIC", "silver_directorship", "directorship_id"),
        # Person <-> banned-register candidates are NOT auto-attached: synthetic people must never inherit real
        # named individuals' records. They surface only as possible matches in Resolution Review (SPEC 8.5).
    ]
    out = parts[0]
    for p in parts[1:]:
        out = out.unionByName(p)
    return (out.withColumn("source_record_id", F.substring(F.sha2(F.concat_ws("|", "entity_id", "source_table", "source_key"), 256), 1, 20))
               .withColumn("loaded_at", F.current_timestamp())
               .dropDuplicates(["source_record_id"]))
