"""Silver: historical prosecution facts extracted by LLM from real ASIC v ... judgments (SPEC 9.1 'Building the
historical prosecution dataset', steps 1-2). Streaming, so each judgment is sent to the model once.

AI output: model and time are recorded on every row; a person spot-checks a sample (step 4).
"""
import json
from pyspark import pipelines as dp
from pyspark.sql import functions as F
from utilities.common import llm_endpoint

MATTER_DDL = ("is_asic_enforcement BOOLEAN, respondents ARRAY<STRING>, respondent_acns ARRAY<STRING>, "
              "provisions ARRAY<STRING>, outcome STRING, success BOOLEAN, penalty_aud DOUBLE, "
              "compensation_aud DOUBLE, filed_date STRING, judgment_date STRING")

_nullable = lambda t: {"type": [t, "null"]}
RESPONSE_FORMAT = json.dumps({
    "type": "json_schema",
    "json_schema": {
        "name": "asic_matter",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "is_asic_enforcement": {"type": "boolean"},
                "respondents": {"type": "array", "items": {"type": "string"}},
                "respondent_acns": {"type": "array", "items": {"type": "string"}},
                "provisions": {"type": "array", "items": {"type": "string"}},
                "outcome": {"type": "string", "enum": ["penalty", "compensation", "declaration", "banning", "injunction",
                                                         "winding_up", "dismissed", "settled", "other"]},
                "success": _nullable("boolean"),
                "penalty_aud": _nullable("number"),
                "compensation_aud": _nullable("number"),
                "filed_date": _nullable("string"),
                "judgment_date": _nullable("string"),
            },
            "required": ["is_asic_enforcement", "respondents", "respondent_acns", "provisions", "outcome", "success",
                         "penalty_aud", "compensation_aud", "filed_date", "judgment_date"],
            "additionalProperties": False,
        },
    },
})

PROMPT = ("You extract facts from an Australian court decision in a matter brought by ASIC. "
          "Return respondents (people and companies), any ACNs (9 digits), provisions contravened "
          "(e.g. s180 Corporations Act), the outcome, whether ASIC succeeded, pecuniary penalty and "
          "compensation in AUD (null if none), and the filing and judgment dates as yyyy-MM-dd (null if unknown). "
          "Set is_asic_enforcement false if ASIC is not the moving party. Decision text follows. ")


@dp.table(comment="LLM-extracted matter facts per ASIC v ... judgment (AI output, unreviewed). provenance=derived")
@dp.expect("extraction_succeeded", "ai_error IS NULL")
def silver_judgment_matters():
    endpoint = llm_endpoint()
    ai = (f"ai_query('{endpoint}', concat('{PROMPT}', substring(text, 1, 40000)), "
          f"responseFormat => '{RESPONSE_FORMAT}', failOnError => false)")
    return (spark.readStream.table("bronze_p10_open_au_legal_corpus")
            .select("version_id", "citation", F.col("date").alias("decision_date_raw"), "url", F.expr(ai).alias("ai"))
            .select("version_id", "citation", "decision_date_raw", "url",
                    F.from_json("ai.result", MATTER_DDL).alias("m"),
                    F.col("ai.errorMessage").alias("ai_error"),
                    F.lit(endpoint).alias("ai_model"), F.current_timestamp().alias("ai_generated_at"))
            .select("*", "m.*").drop("m")
            .withColumn("ai_flag", F.lit(True))
            .withColumn("provenance", F.lit("derived")))
