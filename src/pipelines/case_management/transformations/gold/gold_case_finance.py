"""Gold: case budgets and monthly spend for the Portfolio and Executive Briefing (SPEC 7 S2, S7).

Internal ASIC cost data is never public, so budgets and spend are synthetic. They are derived deterministically from each
case's estimated litigation cost and cost to date (hash-based noise, no randomness), and flagged provenance=synthetic.
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F

CATEGORIES = [("Investigation", 0.40), ("Litigation", 0.42), ("Expert & counsel", 0.18)]
AS_OF = "date'2026-11-06'"  # pinned so reruns are reproducible; matches the pipeline's synthetic 'today'


def _u(*cols):
    """Deterministic uniform [0,1) from a hash of the given columns."""
    return (F.abs(F.xxhash64(*cols)) % 10000) / 10000.0


@dp.materialized_view(comment="Approved budget per case and category (synthetic)")
def gold_case_budget():
    c = spark.read.table("silver_case").select("case_id", "team_id", "est_litigation_cost_aud")
    cats = spark.createDataFrame(CATEGORIES, "category string, share double")
    return (c.crossJoin(cats)
            .withColumn("approved_budget_aud", F.round(F.col("est_litigation_cost_aud") * 1.15 * F.col("share") * (0.9 + 0.2 * _u("case_id", "category")), -3))
            .withColumn("approved_at", F.lit(None).cast("date"))
            .select("case_id", "team_id", "category", "approved_budget_aud", F.lit("synthetic").alias("provenance")))


@dp.materialized_view(comment="Monthly spend per case and category from opening to the as-of date; sums to cost_to_date (synthetic)")
def gold_case_spend():
    c = (spark.read.table("silver_case")
         .select("case_id", "team_id", "stage", "cost_to_date_aud",
                 F.trunc(F.to_date("opened_at"), "MM").alias("start_month"))
         .withColumn("end_month", F.trunc(F.expr(AS_OF), "MM")))
    months = (c.withColumn("month", F.explode(F.expr("sequence(start_month, end_month, interval 1 month)")))
              .withColumn("m_idx", F.months_between("month", "start_month"))
              .withColumn("n_months", F.months_between("end_month", "start_month") + 1))
    cats = spark.createDataFrame(CATEGORIES, "category string, share double")
    # Spend ramps up over the life of a case; litigation spend only starts after the first third
    x = (months.crossJoin(cats)
         .withColumn("ramp", F.when((F.col("category") == "Litigation") & (F.col("m_idx") < F.col("n_months") / 3), 0.0)
                              .otherwise((0.5 + F.col("m_idx") / F.col("n_months")) * (0.6 + 0.8 * _u("case_id", "month", "category"))))
         .withColumn("w", F.col("ramp") * F.col("share")))
    tot = x.groupBy("case_id").agg(F.sum("w").alias("w_total"))
    return (x.join(tot, "case_id")
            .withColumn("spend_aud", F.round(F.col("cost_to_date_aud") * F.col("w") / F.col("w_total"), 0))
            .select("case_id", "team_id", "category", "month", "spend_aud", F.lit("synthetic").alias("provenance")))
