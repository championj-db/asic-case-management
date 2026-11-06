"""Silver: resolution review queue (SPEC 7 S5, 8.5). Possible matches a person must confirm before merging."""
from pyspark import pipelines as dp
from pyspark.sql import functions as F


@dp.materialized_view(comment="Possible matches with 0.6 <= match_score < 0.9, pending human review")
@dp.expect("score_in_review_band", "match_score >= 0.6 AND match_score < 0.9")
def silver_resolution_review():
    persons = (spark.read.table("person_banned_match_candidates").filter("match_score >= 0.6 AND match_score < 0.9")
               .select("entity_id", F.lit("silver_banned_party").alias("candidate_source"), F.col("banned_party_id").alias("candidate_key"),
                       F.col("banned_name").alias("candidate_name"), "match_score", "match_reasons"))
    # Banned organisations without an ACN: exact normalised-name match to a focus company
    orgs = (spark.read.table("silver_banned_party").filter("party_type = 'organisation' AND acn IS NULL")
            .select("banned_party_id", "name", "name_norm")
            .join(spark.read.table("silver_company").join(spark.read.table("silver_curated_slice").select("acn"), "acn")
                  .select("acn", "name_norm"), "name_norm")
            .select(F.concat(F.lit("CO-"), "acn").alias("entity_id"), F.lit("silver_banned_party").alias("candidate_source"),
                    F.col("banned_party_id").alias("candidate_key"), F.col("name").alias("candidate_name"),
                    F.lit(0.75).alias("match_score"), F.array(F.lit("name")).alias("match_reasons")))
    return (persons.unionByName(orgs)
            .withColumn("review_id", F.substring(F.sha2(F.concat_ws("|", "entity_id", "candidate_source", "candidate_key"), 256), 1, 16))
            .withColumn("status", F.lit("pending"))
            .withColumn("created_at", F.current_timestamp()))
