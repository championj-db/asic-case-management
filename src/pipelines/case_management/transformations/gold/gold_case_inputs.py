"""Gold: one row per open case with every PPS input (SPEC 8.2), consumed by notebook 05 and the Scenario Modeller."""
from pyspark import pipelines as dp
from pyspark.sql import functions as F


@dp.materialized_view(comment="PPS / what-if inputs per open case (estimates are synthetic; counsel strength overrides AI coverage)")
@dp.expect_all_or_fail({"has_respondent": "respondent_entity_id IS NOT NULL", "positive_cost": "est_litigation_cost_aud > 0"})
def gold_case_inputs():
    smr_recent = (spark.read.table("silver_austrac_smr")
                  .filter(F.col("report_date") > F.add_months(F.current_date(), -12))
                  .select(F.col("acn").alias("respondent_acn")).distinct()
                  .withColumn("recent_smr_flag", F.lit(True)))
    # Share of offence elements covered by tagged evidence: tags are captured in the app (Lakebase), so null here.
    return (spark.read.table("silver_case")
            .join(smr_recent, "respondent_acn", "left")
            .select("case_id", "case_number", "title", "case_type", "stage", "priority", "team_id", "lead_user", "opened_at",
                    F.concat(F.lit("CO-"), "respondent_acn").alias("respondent_entity_id"), "respondent_acn",
                    "est_recoverable_aud", "est_litigation_cost_aud", "est_duration_months", "cost_to_date_aud",
                    "consumers_affected", "total_consumer_loss_aud", "vulnerable_cohort", "strategic_priority_score",
                    "counsel_evidence_strength", F.lit(None).cast("double").alias("evidence_element_coverage"),
                    "limitation_date", F.coalesce("recent_smr_flag", F.lit(False)).alias("recent_smr_flag"),
                    "story_tag", "provenance"))
