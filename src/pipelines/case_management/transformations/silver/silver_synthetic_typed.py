"""Silver: cleaned synthetic gap-layer datasets (already typed by the generators), deduplicated on their keys."""
from pyspark import pipelines as dp

# silver name -> (bronze_syn_<dataset>, key columns, comment)
SILVER_SYNTHETIC = {
    "silver_curated_slice": ("curated_slice", ["acn"], "Curated focus companies (selection over real P1 companies)"),
    "silver_person": ("persons", ["person_id"], "People (synthetic)"),
    "silver_directorship": ("directorships", ["person_id", "acn"], "Director / secretary appointments (synthetic)"),
    "silver_ato_profile": ("ato_tax_profile", ["acn", "period_end"], "ATO debt, lodgement, STP payroll by quarter (synthetic)"),
    "silver_austrac_smr": ("austrac_smr", ["smr_id"], "AUSTRAC suspicious matter reports (synthetic, AUSTRAC-RESTRICTED)"),
    "silver_apra_flag": ("apra_prudential_flags", ["acn", "prudential_flag", "flag_date"], "APRA prudential flags (synthetic)"),
    "silver_afca_complaints": ("afca_complaints", ["acn", "year"], "AFCA complaints by year (synthetic stand-in for web-only P15)"),
    "silver_enforcement_alternative": ("enforcement_alternatives", ["outcome_id"], "EUs, infringement notices, MDP outcomes (synthetic stand-in for P8)"),
    "silver_published_notice": ("published_notices", ["notice_id"], "Insolvency / deregistration notices (synthetic stand-in for P7)"),
    "silver_breach_report": ("breach_reports", ["intake_id"], "Intake queue items (synthetic)"),
    "silver_case": ("cases", ["case_id"], "Open enforcement cases (synthetic)"),
    "silver_case_party": ("case_parties", ["case_id", "party_kind", "party_ref"], "Case parties (synthetic)"),
    "silver_team": ("teams", ["team_id"], "Teams"),
    "silver_user": ("users", ["user_id"], "Users and personas"),
    "silver_evidence_manifest": ("evidence_manifest", ["evidence_id"], "Evidence manifest: custodian, source system, creation hash"),
}


def _silver(name, dataset, keys, comment):
    @dp.materialized_view(name=name, comment=f"{comment}. provenance=synthetic")
    @dp.expect_all_or_drop({f"{k}_present": f"{k} IS NOT NULL" for k in keys})
    def _f():
        return (spark.read.table(f"bronze_syn_{dataset}")
                .drop("_source_file", "_ingested_at")
                .dropDuplicates(keys))


for _name, (_ds, _keys, _comment) in SILVER_SYNTHETIC.items():
    _silver(_name, _ds, _keys, _comment)
