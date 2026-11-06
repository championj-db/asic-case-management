"""Silver: relationships between resolved entities (SPEC 8.5 graph: directorships, shared attributes)."""
from pyspark import pipelines as dp
from pyspark.sql import functions as F


@dp.materialized_view(comment="Entity relationships: director_of / secretary_of (person -> company), shares_business_name (company -> company)")
@dp.expect_all_or_drop({"has_from": "from_entity IS NOT NULL", "has_to": "to_entity IS NOT NULL"})
def silver_relationship():
    officers = (spark.read.table("silver_directorship")
                .select(F.concat(F.lit("PE-"), "person_id").alias("from_entity"), F.concat(F.lit("CO-"), "acn").alias("to_entity"),
                        F.when(F.col("role").contains("Director"), "director_of").otherwise("secretary_of").alias("rel_type"),
                        F.lit("silver_directorship").alias("source"),
                        F.col("appointed_date").alias("valid_from"), F.col("ceased_date").alias("valid_to"),
                        F.lit("synthetic").alias("provenance")))
    # Phoenix signal (SPEC 9.1 P2): a business name moving between related ABNs. Same normalised name on two focus companies.
    focus = (spark.read.table("silver_company").join(spark.read.table("silver_curated_slice").select("acn"), "acn")
             .select("acn", "abn"))
    bn = (spark.read.table("bronze_p02_asic_business_names")
          .select(F.trim("bn_abn").alias("abn"), F.upper(F.trim("bn_name")).alias("bn"),
                  F.expr("try_to_date(trim(bn_reg_dt), 'dd/MM/yyyy')").alias("bn_reg"))
          .dropDuplicates(["abn", "bn"]).join(focus, "abn"))
    shared = (bn.alias("a").join(bn.alias("b"), (F.col("a.bn") == F.col("b.bn")) & (F.col("a.acn") < F.col("b.acn")))
              .select(F.concat(F.lit("CO-"), F.col("a.acn")).alias("from_entity"), F.concat(F.lit("CO-"), F.col("b.acn")).alias("to_entity"),
                      F.lit("shares_business_name").alias("rel_type"), F.lit("bronze_p02_asic_business_names").alias("source"),
                      F.greatest(F.col("a.bn_reg"), F.col("b.bn_reg")).alias("valid_from"), F.lit(None).cast("date").alias("valid_to"),
                      F.lit("public").alias("provenance")))
    return officers.unionByName(shared).dropDuplicates(["from_entity", "to_entity", "rel_type"])
