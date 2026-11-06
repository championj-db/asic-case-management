"""Bronze: synthetic gap layer written by notebooks 02 and 03 (SPEC 9.1 'gaps that public data cannot fill').

Notebooks regenerate these parquet folders deterministically (overwrite), so each is a materialized view
(full-refresh semantics) rather than an append-only stream.
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F
from utilities.common import raw_path

SYNTHETIC = {
    "curated_slice": "Curated ~5k focus companies (selection over real P1 companies)",
    "persons": "Synthetic people (directors, officeholders, witnesses)",
    "directorships": "Synthetic director/secretary appointments over real companies",
    "ato_tax_profile": "Synthetic ATO debt, lodgement and STP payroll by quarter",
    "austrac_smr": "Synthetic AUSTRAC suspicious matter reports (restricted)",
    "apra_prudential_flags": "Synthetic APRA prudential flags for licensees",
    "afca_complaints": "Synthetic AFCA complaints by licensee and year (P15 is web-only)",
    "enforcement_alternatives": "Synthetic EUs / infringement notices / MDP outcomes (P8 is web-only)",
    "published_notices": "Synthetic insolvency and deregistration notices (P7 is web-only)",
    "breach_reports": "Synthetic intake items: breach reports and reports of misconduct",
    "historical_matters": "Synthetic historical matters: litigation cost, duration, recovery (estimates)",
    "teams": "Enforcement teams",
    "users": "Demo users and personas",
    "cases": "Open enforcement cases (incl. 3 story cases)",
    "case_parties": "Case parties: respondents and witnesses",
    "evidence_manifest": "Evidence document manifest: custodian, source system, creation hash",
}


def _synthetic(dataset, comment):
    @dp.materialized_view(name=f"bronze_syn_{dataset}", comment=comment)
    def _bronze():
        return (spark.read.format("parquet").load(raw_path("synthetic", dataset))
                .withColumn("_source_file", F.col("_metadata.file_path"))
                .withColumn("_ingested_at", F.current_timestamp()))


for _ds, _comment in SYNTHETIC.items():
    _synthetic(_ds, _comment)
