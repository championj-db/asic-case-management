"""Gold: Entity 360 profile for companies in the focus slice (SPEC 7 S5). AUSTRAC is exposed as counts only."""
from pyspark import pipelines as dp
from pyspark.sql import functions as F, Window as W


@dp.materialized_view(comment="Entity 360 panel fields per company: ASIC, licences, ABR, ATO, APRA, AUSTRAC (count), AFCA, bans, cases")
def gold_entity_profile():
    t = spark.read.table
    ent = t("silver_entity").filter("entity_type IN ('company', 'licensee')").withColumn("acn", F.col("abn_acn"))
    co = t("silver_company").select("acn", "type", "class", "reg_date", "dereg_date")
    lic = (t("silver_licensee").groupBy("acn")
           .agg(F.collect_list(F.struct("licence_no", "licence_type", "status", "start_date", "end_date")).alias("licences")))
    abr = (t("silver_abn_register").filter("acn IS NOT NULL").groupBy("acn")
           .agg(F.max_by("gst_status", "snapshot").alias("gst_status"), F.max_by("abn_status", "snapshot").alias("abn_status")))
    w = W.partitionBy("acn").orderBy(F.desc("period_end"))
    ato = (t("silver_ato_profile").withColumn("_rn", F.row_number().over(w)).filter("_rn = 1")
           .select("acn", F.col("period_end").alias("ato_period"), F.col("ato_debt_aud").alias("ato_debt_aud"),
                   "lodgement_on_time_pct", "stp_headcount"))
    apra = t("silver_apra_flag").groupBy("acn").agg(F.count("*").alias("apra_flag_count"), F.collect_set("prudential_flag").alias("apra_flags"))
    austrac = t("silver_austrac_smr").groupBy("acn").agg(F.count("*").alias("austrac_restricted_record_count"))
    afca = t("silver_afca_complaints").groupBy("acn").agg(F.max_by("complaints", "year").alias("afca_complaints_latest"))
    org_ban = (t("silver_banned_party").filter("acn IS NOT NULL").groupBy("acn")
               .agg(F.collect_list(F.struct("ban_type", "start_date", "end_date")).alias("organisation_bans")))
    dir_matches = (t("silver_directorship").select(F.concat(F.lit("PE-"), "person_id").alias("entity_id"), "acn")
                   .join(t("person_banned_match_candidates").filter("match_score >= 0.6").select("entity_id", "match_score"), "entity_id")
                   .groupBy("acn").agg(F.countDistinct("entity_id").alias("directors_possible_banned_match")))
    cases = (t("silver_case").filter("stage <> 'Closed'").groupBy(F.col("respondent_acn").alias("acn"))
             .agg(F.count("*").alias("open_cases")))
    sources = (t("silver_source_record").filter("entity_id LIKE 'CO-%'").groupBy("entity_id")
               .agg(F.count("*").alias("source_record_count"), F.collect_set("agency").alias("agencies")))
    collapse = t("silver_company_collapse").select("acn", "collapse_status", "collapse_date")
    # Real ATO values for large corporates (P12): latest income year per ACN
    ato_tt = (t("silver_ato_tax_transparency").filter("acn IS NOT NULL").groupBy("acn")
              .agg(F.max("income_year").alias("ato_tt_income_year"),
                   F.max_by("total_income_aud", "income_year").alias("ato_tt_total_income_aud"),
                   F.max_by("taxable_income_aud", "income_year").alias("ato_tt_taxable_income_aud"),
                   F.max_by("tax_payable_aud", "income_year").alias("ato_tt_tax_payable_aud")))
    # Sanctions screening (P17): exact normalised-name match on any listed name or alias -> possible match only
    sanctions = (t("silver_company").select("acn", "name_norm")
                 .join(t("silver_sanctions_list").filter("length(name_norm) > 3").select("name_norm", "sanction_ref"), "name_norm")
                 .groupBy("acn").agg(F.collect_set("sanction_ref").alias("sanctions_possible_match_refs")))
    out = ent.join(sources, "entity_id", "left")
    for part in (co, lic, abr, ato, apra, austrac, afca, org_ban, dir_matches, cases, collapse, ato_tt, sanctions):
        out = out.join(part, "acn", "left")
    return out.fillna(0, subset=["apra_flag_count", "austrac_restricted_record_count", "directors_possible_banned_match",
                                 "open_cases", "source_record_count"])
