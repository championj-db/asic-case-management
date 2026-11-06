"""Gold: case timeline events (SPEC 4 'Event', 9 'event'). Register-sourced events are confirmed; AI events stay
'suggested' until an investigator confirms them in the app (only confirmed items show on the Timeline).
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F


def _ev(df, date_col, event_type, desc, status, source, evidence_expr="CAST(array() AS ARRAY<STRING>)"):
    return df.select("case_id", F.to_date(F.col(date_col)).alias("event_date"), F.expr(event_type).alias("event_type"),
                     F.expr(desc).alias("description"), F.expr(evidence_expr).alias("evidence_ids"),
                     F.array(F.concat(F.lit("CO-"), "respondent_acn")).alias("entity_ids"),
                     F.lit(status).alias("status"), F.lit(source).alias("source"))


@dp.materialized_view(comment="Timeline events per case (registers, intake, notices, Evidence AI suggestions)")
@dp.expect_or_drop("has_date", "event_date IS NOT NULL")
def gold_case_event():
    cases = spark.read.table("silver_case").select("case_id", "respondent_acn", "opened_at")
    resp = cases.select("case_id", "respondent_acn")
    by_acn = lambda name: resp.join(spark.read.table(name).withColumnRenamed("acn", "respondent_acn"), "respondent_acn")
    ai = (spark.read.table("silver_evidence_extraction").filter("kind = 'event' AND event_date IS NOT NULL")
          .join(resp, "case_id"))
    events = (_ev(cases, "opened_at", "'Case opened'", "'Case opened at Assessment'", "confirmed", "silver_case")
              .unionByName(_ev(by_acn("silver_published_notice"), "notice_date", "'Published notice'", "notice_type", "confirmed", "silver_published_notice"))
              .unionByName(_ev(by_acn("silver_breach_report"), "received_at", "report_kind", "summary", "confirmed", "silver_breach_report"))
              .unionByName(_ev(by_acn("silver_company_status_history"), "valid_from", "'Register status'",
                               "concat('ASIC register status: ', status)", "confirmed", "silver_company_status_history"))
              .unionByName(_ev(by_acn("silver_enforcement_alternative"), "outcome_date", "outcome_type", "provision", "confirmed", "silver_enforcement_alternative"))
              .unionByName(_ev(ai, "event_date", "'Evidence event'", "value", "suggested", "silver_evidence_extraction", "array(evidence_id)")))
    return (events.withColumn("ai_flag", F.col("source") == "silver_evidence_extraction")
                  .withColumn("event_id", F.substring(F.sha2(F.concat_ws("|", "case_id", "event_date", "event_type", "description", "source"), 256), 1, 16))
                  .dropDuplicates(["event_id"]))
