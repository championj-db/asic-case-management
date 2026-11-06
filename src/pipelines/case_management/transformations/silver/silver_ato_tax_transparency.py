"""Silver: ATO Corporate Tax Transparency (P12), real values for large corporates (SPEC 9.1: the 'ATO' panel).

Each yearly workbook has an 'Income tax details' sheet: Name, ABN, Total income $, Taxable income $, Tax payable $,
Income year. Workbooks without that sheet are skipped.
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F, Window as W
from utilities.common import raw_path, snake_cols, first_col, acn_from_abn_or_acn


@dp.materialized_view(comment="ATO tax transparency: total income, taxable income, tax payable by ABN and income year. provenance=public")
@dp.expect_or_drop("valid_abn", "abn RLIKE '^[0-9]{11}$'")
def silver_ato_tax_transparency():
    df = snake_cols(spark.read.format("excel")
                    .option("headerRows", 1)
                    .option("dataAddress", "Income tax details")
                    .option("ignoreMissingSheet", True)
                    .option("recursiveFileLookup", True)
                    .option("pathGlobFilter", "*.xlsx")
                    .load(raw_path("public", "p12_ato_tax_transparency"))
                    .select("*", F.col("_metadata.file_path").alias("_source_file")))
    out = df.select(
        F.trim(first_col(df, r"^(entity_)?name$")).alias("name"),
        F.regexp_replace(first_col(df, r"^abn$").cast("string"), r"[^0-9]", "").alias("abn"),
        first_col(df, r"^total_income").cast("double").alias("total_income_aud"),
        first_col(df, r"^taxable_income").cast("double").alias("taxable_income_aud"),
        first_col(df, r"^tax_payable").cast("double").alias("tax_payable_aud"),
        F.trim(first_col(df, r"^income_year").cast("string")).alias("income_year"),
        "_source_file",
        F.expr("try_to_date(regexp_extract(_source_file, 'snapshot=([0-9]{8})', 1), 'yyyyMMdd')").alias("_snapshot"))
    w = W.partitionBy("abn", "income_year").orderBy(F.desc("_snapshot"))
    return (out.withColumn("_rn", F.row_number().over(w)).filter("_rn = 1").drop("_rn")
               .withColumn("acn", acn_from_abn_or_acn(F.col("abn")))
               .withColumn("provenance", F.lit("public")))
