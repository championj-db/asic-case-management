"""Bronze: public non-tabular sources (SPEC 9.1 P10, P11, and the XLSX workbooks P6, P12, P13, P14, P17)."""
from pyspark import pipelines as dp
from pyspark.sql import functions as F
from utilities.common import raw_path, with_file_lineage


@dp.table(comment="Open Australian Legal Corpus (P10): ASIC v ... decisions only, one row per decision. provenance=public")
@dp.expect("has_text", "text IS NOT NULL")
def bronze_p10_open_au_legal_corpus():
    df = (spark.readStream.format("cloudFiles")
          .option("cloudFiles.format", "json")
          .option("pathGlobFilter", "*.jsonl")
          .load(raw_path("public", "p10_open_au_legal_corpus")))
    return with_file_lineage(df.select("*", "_metadata"), "public").drop("_metadata")


@dp.table(comment="ABN Bulk Extract (P11): one VARIANT record per <ABR> element. provenance=public")
def bronze_p11_abn_bulk_extract():
    df = (spark.readStream.format("cloudFiles")
          .option("cloudFiles.format", "xml")
          .option("rowTag", "ABR")
          .option("singleVariantColumn", "record")  # robust to the deeply nested, sparse ABR schema
          .option("pathGlobFilter", "*.xml")
          .load(raw_path("public", "p11_abn_bulk_extract")))
    return with_file_lineage(df.select("*", "_metadata"), "public").drop("_metadata")


@dp.table(comment="Catalogue of public XLSX workbooks (P6 insolvency stats, P12 ATO tax transparency, "
                  "P13/P14 APRA statistics, P17 DFAT sanctions) with bytes and SHA-256. Sheet-level parsing is downstream.")
def bronze_public_workbooks():
    df = (spark.readStream.format("cloudFiles")
          .option("cloudFiles.format", "binaryFile")
          .option("pathGlobFilter", "*.xlsx")
          .load(raw_path("public")))
    return (with_file_lineage(df.select("*", "_metadata"), "public").drop("_metadata")
            .withColumn("source_id", F.regexp_extract("path", r"/public/([^/]+)/", 1))
            .withColumn("file_name", F.regexp_extract("path", r"([^/]+)$", 1))
            .withColumn("sha256", F.sha2("content", 256)))
