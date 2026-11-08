"""Gold: network edges for the Entities & Network tab (SPEC 8.5). Depth-2 neighbourhoods are served by the API.

Possible banned-register matches are separate 'possible_match' edges (identity is not merged; SPEC 3).
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F


@dp.materialized_view(comment="Weighted edges: officer_of, shares_director, co_director, shares_business_name, possible_match")
def gold_entity_network():
    rel = spark.read.table("silver_relationship")
    officers = rel.filter("rel_type IN ('director_of', 'secretary_of')").select("from_entity", "to_entity")
    officer_edges = (officers.groupBy("from_entity", "to_entity").agg(F.count("*").alias("weight"))
                     .withColumn("rel_type", F.lit("officer_of")))
    a, b = officers.alias("a"), officers.alias("b")
    shares_director = (a.join(b, (F.col("a.from_entity") == F.col("b.from_entity")) & (F.col("a.to_entity") < F.col("b.to_entity")))
                       .groupBy(F.col("a.to_entity").alias("from_entity"), F.col("b.to_entity").alias("to_entity"))
                       .agg(F.countDistinct("a.from_entity").alias("weight")).withColumn("rel_type", F.lit("shares_director")))
    co_director = (a.join(b, (F.col("a.to_entity") == F.col("b.to_entity")) & (F.col("a.from_entity") < F.col("b.from_entity")))
                   .groupBy(F.col("a.from_entity").alias("from_entity"), F.col("b.from_entity").alias("to_entity"))
                   .agg(F.countDistinct("a.to_entity").alias("weight")).withColumn("rel_type", F.lit("co_director")))
    names = (rel.filter("rel_type = 'shares_business_name'").groupBy("from_entity", "to_entity")
             .agg(F.count("*").alias("weight")).withColumn("rel_type", F.lit("shares_business_name")))
    possible = (spark.read.table("person_banned_match_candidates").filter("match_score >= 0.6")
                .select(F.col("entity_id").alias("from_entity"), F.concat(F.lit("BAN-"), "banned_party_id").alias("to_entity"),
                        F.col("match_score").alias("weight"), F.lit("possible_match").alias("rel_type")))
    return (officer_edges.withColumn("weight", F.col("weight").cast("double"))
            .unionByName(shares_director.withColumn("weight", F.col("weight").cast("double")))
            .unionByName(co_director.withColumn("weight", F.col("weight").cast("double")))
            .unionByName(names.withColumn("weight", F.col("weight").cast("double")))
            .unionByName(possible.withColumn("weight", F.col("weight").cast("double")))
            # Officer appointments are synthetic over real companies; business names are real (P2); possible matches are derived
            .withColumn("provenance", F.when(F.col("rel_type") == "shares_business_name", "public")
                                       .when(F.col("rel_type") == "possible_match", "derived").otherwise("synthetic")))
