"""Gold: point-in-time features and collapse labels for the collapse model (SPEC 8.1; contract in CONTRACT.md).

One row per (company, as_of_date). as_of dates are the quarterly ATO periods. No feature uses data after as_of_date,
and rows on/after the company's collapse are excluded. Labels are null until the horizon has been observed.
The register status itself is never a feature.
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F, Window as W


def _window_count(keys, df, date_col, months, aggs):
    """Aggregate df rows whose date is in (as_of - months, as_of] (months=None -> all history up to as_of)."""
    j = keys.join(df.withColumnRenamed(date_col, "_d"), "acn").filter(F.col("_d") <= F.col("as_of_date"))
    if months:
        j = j.filter(F.col("_d") > F.add_months("as_of_date", -months))
    return j.groupBy("acn", "as_of_date").agg(*aggs)


@dp.materialized_view(comment="Collapse-model features and labels per company and quarter (point-in-time)", cluster_by=["entity_id"])
@dp.expect_or_fail("no_post_collapse_rows", "collapse_date IS NULL OR collapse_date > as_of_date")
@dp.expect("label_12m_implies_24m", "label_collapse_12m IS NULL OR label_collapse_24m IS NULL OR label_collapse_12m <= label_collapse_24m")
def gold_entity_features():
    t = spark.read.table
    slc = t("silver_curated_slice").select("acn", F.col("is_licensee").cast("int").alias("is_licensee"))
    collapse = t("silver_company_collapse").select("acn", "collapse_date")
    w = W.partitionBy("acn").orderBy("period_end")
    pct = lambda now, before: F.when(before > 0, F.round((now - before) / before * 100, 2)).otherwise(F.lit(0.0))

    ato = (t("silver_ato_profile").join(slc.select("acn"), "acn")
           .withColumn("debt_lag2", F.lag("ato_debt_aud", 2).over(w))
           .withColumn("stp_lag2", F.lag("stp_headcount", 2).over(w))
           .select("acn", F.col("period_end").alias("as_of_date"),
                   F.col("ato_debt_aud").alias("ato_debt_latest_aud"),
                   pct(F.col("ato_debt_aud"), F.col("debt_lag2")).alias("ato_debt_trend_6m_pct"),
                   "lodgement_on_time_pct",
                   pct(F.col("stp_headcount"), F.col("stp_lag2")).alias("stp_headcount_trend_pct"),
                   (~F.col("gst_registered")).cast("int").alias("gst_cancelled")))
    base = (ato.join(slc, "acn")
            .join(t("silver_company").select("acn", "reg_date"), "acn", "left")
            .join(collapse, "acn", "left")
            .filter(F.col("collapse_date").isNull() | (F.col("collapse_date") > F.col("as_of_date"))))
    keys = base.select("acn", "as_of_date")

    smr = _window_count(keys, t("silver_austrac_smr").select("acn", "report_date", "flow_band"), "report_date", 24,
                        [F.count("*").alias("smr_count_24m"),
                         F.sum(F.col("flow_band").isin("100k-1m", ">1m").cast("int")).alias("large_flow_smr_count_24m")])
    apra = _window_count(keys, t("silver_apra_flag").select("acn", "flag_date"), "flag_date", None, [F.count("*").alias("apra_flag_count")])
    breaches = _window_count(keys, t("silver_breach_report").select("acn", F.to_date("received_at").alias("rd")), "rd", 12,
                             [F.count("*").alias("breach_reports_12m")])
    alts = _window_count(keys, t("silver_enforcement_alternative").select("acn", "outcome_date"), "outcome_date", None,
                         [F.count("*").alias("enforcement_alternatives_count")])
    afca = (keys.join(t("silver_afca_complaints").select("acn", "year", "complaints"), "acn")
            .groupBy("acn", "as_of_date")
            .agg(F.sum(F.when(F.col("year") == F.year("as_of_date"), F.col("complaints"))).alias("afca_now"),
                 F.sum(F.when(F.col("year") == F.year("as_of_date") - 1, F.col("complaints"))).alias("afca_prev"))
            .select("acn", "as_of_date", F.coalesce("afca_now", F.lit(0)).alias("afca_complaints_latest"),
                    pct(F.coalesce("afca_now", F.lit(0)), F.col("afca_prev")).alias("afca_complaints_trend_pct")))

    # Directors in office at as_of
    d = t("silver_directorship").select("person_id", "acn", "appointed_date", "ceased_date")
    in_office = (keys.join(d, "acn")
                 .filter((F.col("appointed_date") <= F.col("as_of_date")) &
                         (F.col("ceased_date").isNull() | (F.col("ceased_date") >= F.col("as_of_date"))))
                 .select("acn", "as_of_date", "person_id"))
    banned_people = (spark.read.table("person_banned_match_candidates").filter("match_score >= 0.6")
                     .select(F.regexp_replace("entity_id", "^PE-", "").alias("person_id"), "start_date").distinct())
    banned = (in_office.join(banned_people, "person_id")
              .filter(F.col("start_date").isNull() | (F.col("start_date") <= F.col("as_of_date")))
              .groupBy("acn", "as_of_date").agg(F.countDistinct("person_id").alias("banned_director_count")))
    other = d.select("person_id", F.col("acn").alias("acn2")).join(collapse.withColumnRenamed("acn", "acn2"), "acn2")
    prior = (in_office.join(other, "person_id")
             .filter((F.col("acn2") != F.col("acn")) & (F.col("collapse_date") < F.col("as_of_date")))
             .groupBy("acn", "as_of_date")
             .agg(F.countDistinct("acn2").alias("director_prior_failed_companies"),
                  F.countDistinct("person_id").alias("directors_with_prior_failures")))
    # Related via a shared business name (phoenix signal)
    rel = (t("silver_relationship").filter("rel_type = 'shares_business_name'")
           .select(F.regexp_replace("from_entity", "^CO-", "").alias("acn"), F.regexp_replace("to_entity", "^CO-", "").alias("acn2")))
    rel = rel.unionByName(rel.select(F.col("acn2").alias("acn"), F.col("acn").alias("acn2")))
    via_name = (keys.join(rel, "acn").join(collapse.withColumnRenamed("acn", "acn2"), "acn2")
                .filter(F.col("collapse_date") < F.col("as_of_date"))
                .groupBy("acn", "as_of_date").agg(F.countDistinct("acn2").alias("name_related_collapsed")))

    out = base
    for part in (smr, apra, breaches, alts, afca, banned, prior, via_name):
        out = out.join(part, ["acn", "as_of_date"], "left")
    counts = ["smr_count_24m", "large_flow_smr_count_24m", "apra_flag_count", "breach_reports_12m", "enforcement_alternatives_count",
              "afca_complaints_latest", "afca_complaints_trend_pct", "banned_director_count", "director_prior_failed_companies",
              "directors_with_prior_failures", "name_related_collapsed"]
    out = out.fillna(0, subset=counts)

    def label(h):
        return (F.when(F.col("collapse_date") <= F.add_months("as_of_date", h), F.lit(1))
                 .when(F.add_months("as_of_date", h) <= F.current_date(), F.lit(0)))

    return (out.withColumn("entity_id", F.concat(F.lit("CO-"), "acn"))
               .withColumn("company_age_years", F.round(F.datediff("as_of_date", "reg_date") / 365.25, 2))
               .withColumn("related_collapsed_entities", F.col("director_prior_failed_companies") + F.col("name_related_collapsed"))
               .withColumn("label_collapse_12m", label(12))
               .withColumn("label_collapse_24m", label(24))
               .withColumn("provenance", F.lit("derived"))
               .drop("reg_date", "name_related_collapsed"))
