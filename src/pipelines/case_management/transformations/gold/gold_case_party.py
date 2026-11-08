"""Gold: case parties resolved to entity ids (SPEC 9 'case_party'), plus 'related' companies.

Related parties are companies that share a director with the respondent (gold_entity_network 'shares_director'),
so the investigator sees them on the Network tab before expanding.
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F, Window as W


@dp.materialized_view(comment="Case parties keyed by entity_id: respondent, witness, related (shares a director with the respondent)")
@dp.expect_or_drop("has_entity", "entity_id IS NOT NULL")
def gold_case_party():
    parties = (spark.read.table("silver_case_party")
               .select("case_id",
                       F.when(F.col("party_kind") == "company", F.concat(F.lit("CO-"), "party_ref"))
                        .otherwise(F.concat(F.lit("PE-"), "party_ref")).alias("entity_id"),
                       "party_kind", "role", F.lit("silver_case_party").alias("source")))
    resp = (spark.read.table("silver_case").select("case_id", F.concat(F.lit("CO-"), "respondent_acn").alias("resp")))
    net = spark.read.table("gold_entity_network").filter("rel_type = 'shares_director'")
    edges = (net.select(F.col("from_entity").alias("resp"), F.col("to_entity").alias("entity_id"), "weight")
             .unionByName(net.select(F.col("to_entity").alias("resp"), F.col("from_entity").alias("entity_id"), "weight")))
    w = W.partitionBy("case_id").orderBy(F.desc("weight"), "entity_id")
    related = (resp.join(edges, "resp").withColumn("_rn", F.row_number().over(w)).filter("_rn <= 5")
               .select("case_id", "entity_id", F.lit("company").alias("party_kind"), F.lit("related").alias("role"),
                       F.lit("gold_entity_network").alias("source")))
    ents = spark.read.table("silver_entity").select("entity_id", F.col("name").alias("entity_name"), "entity_type")
    return (parties.unionByName(related).dropDuplicates(["case_id", "entity_id"])
            .join(ents, "entity_id", "left").withColumn("provenance", F.lit("synthetic")))
