"""Silver: historical matters = synthetic internal history UNION real matters from judgments (SPEC 9.1 step 3).

Judgment respondents are matched to P1 companies by ACN, or by a unique exact normalised name; later insolvency
is attached from the real status history. Recoveries are never public, so they stay null / estimated.
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F
from utilities.common import norm_name

COLUMNS = ["matter_id", "acn", "matter_type", "filed_date", "judgment_date", "duration_months", "evidence_strength",
           "litigation_cost_aud", "claimed_amount_aud", "success", "collapsed_before_judgment", "recovered_amount_aud",
           "penalty_aud", "compensation_aud", "recovery_is_estimate", "provisions", "citation", "source", "provenance"]


@dp.materialized_view(comment="Historical matters for calibration and past-case panels (synthetic + judgment-derived)")
@dp.expect("has_dates", "filed_date IS NOT NULL OR judgment_date IS NOT NULL")
def silver_historical_matters():
    syn = (spark.read.table("bronze_syn_historical_matters")
           .withColumn("compensation_aud", F.lit(None).cast("double"))
           .withColumn("provisions", F.lit(None).cast("array<string>"))
           .withColumn("citation", F.lit(None).cast("string"))
           .withColumn("source", F.lit("synthetic"))
           .withColumn("success", F.col("success").cast("int"))
           .select(*COLUMNS))

    j = (spark.read.table("silver_judgment_matters").filter("ai_error IS NULL AND is_asic_enforcement")
         .withColumn("matter_id", F.concat(F.lit("J-"), F.substring(F.sha2("version_id", 256), 1, 12))))
    companies = spark.read.table("silver_company").select("name_norm", F.col("acn").alias("name_acn"))
    by_name = (j.select("matter_id", F.explode_outer("respondents").alias("r"))
               .withColumn("name_norm", norm_name(F.col("r"))).filter("length(name_norm) > 3")
               .join(companies, "name_norm")
               .groupBy("matter_id", "name_norm").agg(F.countDistinct("name_acn").alias("n"), F.min("name_acn").alias("name_acn"))
               .filter("n = 1").groupBy("matter_id").agg(F.min("name_acn").alias("name_acn")))
    acn_given = F.filter(F.transform("respondent_acns", lambda a: F.regexp_replace(a, "[^0-9]", "")), lambda a: F.length(a) == 9)
    j = (j.join(by_name, "matter_id", "left")
         .withColumn("acn", F.coalesce(F.element_at(acn_given, 1), F.col("name_acn")))
         .withColumn("filed_date", F.expr("try_to_date(filed_date)"))
         .withColumn("judgment_date", F.coalesce(F.expr("try_to_date(judgment_date)"), F.expr("try_to_date(decision_date_raw)"))))

    collapses = (spark.read.table("silver_company_status_history").filter("is_collapse")
                 .groupBy("acn").agg(F.min("valid_from").alias("collapse_date")))
    j = (j.join(collapses, "acn", "left")
         .withColumn("collapsed_before_judgment",
                     F.when(F.col("acn").isNull(), None)
                      .otherwise((F.col("collapse_date").isNotNull() & (F.col("collapse_date") <= F.col("judgment_date"))).cast("int")))
         .withColumn("matter_type", F.lit("Court proceeding"))
         .withColumn("duration_months", F.round(F.months_between("judgment_date", "filed_date")).cast("int"))
         .withColumn("evidence_strength", F.lit(None).cast("double"))
         .withColumn("litigation_cost_aud", F.lit(None).cast("double"))
         .withColumn("claimed_amount_aud", F.lit(None).cast("double"))
         .withColumn("success", F.col("success").cast("int"))
         .withColumn("recovered_amount_aud", F.lit(None).cast("double"))
         .withColumn("recovery_is_estimate", F.lit(True))
         .withColumn("source", F.lit("judgment"))
         .withColumn("provenance", F.lit("public"))
         .select(*COLUMNS))
    return syn.unionByName(j)
