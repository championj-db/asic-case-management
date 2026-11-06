"""Silver: DFAT Australian Sanctions Consolidated List (P17), latest snapshot. Used as a screening indicator and as
entity-resolution test cases (aliases). A name match is a possible match only, never proof of identity.
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F
from utilities.common import raw_path, snake_cols, first_col, norm_name, latest_snapshot


@dp.materialized_view(comment="DFAT consolidated sanctions list: one row per listed name (primary names and aliases). provenance=public")
@dp.expect_or_drop("has_name", "name IS NOT NULL AND name <> ''")
def silver_sanctions_list():
    df = snake_cols(spark.read.format("excel")
                    .option("headerRows", 1)
                    .option("dataAddress", "Consolidated List")
                    .option("recursiveFileLookup", True)
                    .option("pathGlobFilter", "*.xlsx")
                    .load(raw_path("public", "p17_dfat_sanctions"))
                    .select("*", F.col("_metadata.file_path").alias("_source_file")))
    df = df.withColumn("_snapshot", F.expr("try_to_date(regexp_extract(_source_file, 'snapshot=([0-9]{8})', 1), 'yyyyMMdd')"))
    out = latest_snapshot(df).select(
        first_col(df, r"^reference$").cast("string").alias("reference"),
        F.trim(first_col(df, r"^name_of_individual").cast("string")).alias("name"),
        first_col(df, r"^type$").cast("string").alias("party_type"),
        first_col(df, r"^name_type$").cast("string").alias("name_type"),
        first_col(df, r"^date_of_birth$").cast("string").alias("date_of_birth"),
        first_col(df, r"^citizenship$").cast("string").alias("citizenship"),
        first_col(df, r"^address$").cast("string").alias("address"),
        first_col(df, r"^committees$").cast("string").alias("committees"),
        first_col(df, r"^listing_information$").cast("string").alias("listing_information"),
        "_snapshot")
    return (out.withColumn("sanction_ref", F.regexp_extract("reference", r"^([0-9]+)", 1))
               .withColumn("name_norm", norm_name(F.col("name")))
               .withColumn("provenance", F.lit("public")))
