"""Silver: resolved entities (SPEC 4 'Entity', 8.5). One record per company in the curated slice and per person.

Identity confidence (match_confidence) is kept separate from risk, per SPEC 3 principles.
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F


@dp.materialized_view(comment="Resolved entities: companies / licensees (CO-<acn>) and persons (PE-<person_id>)")
@dp.expect_or_fail("unique_entity_id_present", "entity_id IS NOT NULL")
def silver_entity():
    companies = (spark.read.table("silver_curated_slice").select("acn", "is_licensee", F.col("company_name").alias("slice_name"))
                 .join(spark.read.table("silver_company").select("acn", "abn", "company_name", "status", "type"), "acn", "left")
                 .select(F.concat(F.lit("CO-"), "acn").alias("entity_id"),
                         F.when(F.col("is_licensee") == 1, "licensee").otherwise("company").alias("entity_type"),
                         F.coalesce("company_name", "slice_name").alias("name"),
                         F.col("acn").alias("abn_acn"), "abn", "status",
                         F.lit(1.0).alias("match_confidence"), F.lit("public").alias("provenance")))
    persons = (spark.read.table("silver_person")
               .select(F.concat(F.lit("PE-"), "person_id").alias("entity_id"), F.lit("person").alias("entity_type"),
                       F.concat_ws(" ", "given_name", "middle_initial", "family_name").alias("name"),
                       F.lit(None).cast("string").alias("abn_acn"), F.lit(None).cast("string").alias("abn"),
                       F.lit(None).cast("string").alias("status"),
                       F.lit(1.0).alias("match_confidence"), F.lit("synthetic").alias("provenance")))
    return companies.unionByName(persons)
