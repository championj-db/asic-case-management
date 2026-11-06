"""Bronze: public ASIC / ACNC registers landed by notebook 01 (SPEC 9.1 P1-P5, P18).

One streaming table per source. Every weekly snapshot is kept (status history drives collapse labels).
Columns are kept as raw strings and renamed to Delta-safe snake_case.
"""
from pyspark import pipelines as dp
from utilities.common import raw_path, snake_cols, with_file_lineage

# source_id -> (file glob, delimiter, comment). ASIC files are tab-delimited even when named .csv.
REGISTERS = {
    "p01_asic_companies": ("*.csv", "\t", "ASIC Company Dataset: every company, status, registration/deregistration dates"),
    "p02_asic_business_names": ("*.csv", "\t", "ASIC Business Names Dataset (trading names linked to ABN)"),
    "p03_asic_afs_licensees": ("*.tsv", "\t", "ASIC AFS Licensee register"),
    "p03_asic_credit_licensees": ("*.tsv", "\t", "ASIC Credit Licensee register"),
    "p04_asic_banned_persons": ("*.tsv", "\t", "ASIC Banned and Disqualified Persons"),
    "p04_asic_banned_orgs": ("*.tsv", "\t", "ASIC Banned and Disqualified Organisations"),
    "p05_asic_liquidators": ("*.tsv", "\t", "ASIC registered liquidators"),
    "p18_acnc_register": ("*.csv", ",", "ACNC Register of Australian charities"),
}


def _register(source_id, glob, sep, comment):
    @dp.table(name=f"bronze_{source_id}", comment=f"{comment}. provenance=public")
    def _bronze():
        reader = (spark.readStream.format("cloudFiles")
                  .option("cloudFiles.format", "csv")
                  .option("header", True)
                  .option("sep", sep)
                  .option("pathGlobFilter", glob))
        if sep == "\t":
            reader = reader.option("quote", "")  # ASIC TSVs contain unbalanced quotes in free text
        else:
            reader = reader.option("multiLine", True)
        df = reader.load(raw_path("public", source_id))
        return with_file_lineage(snake_cols(df.select("*", "_metadata")), "public").drop("_metadata")


for _sid, (_glob, _sep, _comment) in REGISTERS.items():
    _register(_sid, _glob, _sep, _comment)
