"""Bronze: evidence documents from the evidence volume (SPEC 8.4 step 1, chain of custody).

Originals are never modified. SHA-256 is taken at ingest and compared to the manifest hash downstream.
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F
from utilities.common import evidence_path


@dp.table(comment="Evidence files (binary) with SHA-256 at ingest. Path layout: <evidence_volume>/<case_id>/<evidence_id>_<type>.pdf")
@dp.expect_or_fail("hash_present", "sha256 IS NOT NULL")
def bronze_evidence_files():
    df = (spark.readStream.format("cloudFiles")
          .option("cloudFiles.format", "binaryFile")
          .option("pathGlobFilter", "*.{pdf,docx,doc,png,jpg,jpeg,tif,tiff,pptx}")
          .load(evidence_path()))
    return (df.withColumn("case_id", F.regexp_extract("path", r"/([^/]+)/[^/]+$", 1))
              .withColumn("file_name", F.regexp_extract("path", r"([^/]+)$", 1))
              .withColumn("evidence_id", F.regexp_extract("file_name", r"^([A-Za-z0-9]+)_", 1))
              .withColumn("sha256", F.sha2("content", 256))
              .withColumn("_ingested_at", F.current_timestamp()))
