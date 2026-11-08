"""Temporary view: probabilistic person matches against the banned register (SPEC 8.5).

Score = 0.65 for exact family name + first given name, +0.15 same state, +0.15 same postcode.
>= 0.9 auto-merges into silver_source_record; 0.6-0.9 goes to silver_resolution_review.
"""
from pyspark import pipelines as dp
from pyspark.sql import Window, functions as F


@dp.temporary_view(comment="Candidate person <-> banned-person matches with score and reasons")
def person_banned_match_candidates():
    p = (spark.read.table("silver_person")
         .select("person_id", F.upper("family_name").alias("fam"), F.upper("given_name").alias("giv"),
                 F.col("state").alias("p_state"), F.col("postcode").cast("string").alias("p_pcode")))
    b = (spark.read.table("silver_banned_party").filter("party_type = 'person'")
         .select("banned_party_id", "name", "ban_type", "start_date", "end_date",
                 F.upper("family_name").alias("fam"), F.upper(F.split("given_names", " ")[0]).alias("giv"),
                 F.col("state").alias("b_state"), F.trim("postcode").alias("b_pcode")))
    state_hit = F.coalesce(F.col("p_state") == F.col("b_state"), F.lit(False))
    pcode_hit = F.coalesce(F.col("p_pcode") == F.col("b_pcode"), F.lit(False))
    return (p.join(b, ["fam", "giv"])
            .withColumn("match_score", F.round(F.lit(0.65) + F.when(state_hit, 0.15).otherwise(0.0) + F.when(pcode_hit, 0.15).otherwise(0.0), 2))
            .withColumn("match_reasons", F.array_compact(F.array(F.lit("name"), F.when(state_hit, F.lit("state")), F.when(pcode_hit, F.lit("postcode")))))
            .select(F.concat(F.lit("PE-"), "person_id").alias("entity_id"), "banned_party_id", F.col("name").alias("banned_name"),
                    "ban_type", "start_date", "end_date", "match_score", "match_reasons")
            # One candidate per (person, banned party): a party can hold several bans, keep the strongest, most recent row
            .withColumn("_rn", F.row_number().over(Window.partitionBy("entity_id", "banned_party_id")
                                                   .orderBy(F.desc("match_score"), F.desc_nulls_last("start_date"))))
            .filter("_rn = 1").drop("_rn"))
