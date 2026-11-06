"""Silver: Evidence AI extraction and summary per document (SPEC 8.4 step 4). Streaming: one LLM call per document.

Outputs are suggestions only; a person confirms them before they reach the Timeline or Network (SPEC 8.7).
"""
import json
from pyspark import pipelines as dp
from pyspark.sql import functions as F
from utilities.common import llm_endpoint

EXTRACTION_DDL = ("summary STRING, people ARRAY<STRING>, companies ARRAY<STRING>, accounts ARRAY<STRING>, "
                  "amounts ARRAY<STRUCT<value: DOUBLE, context: STRING>>, "
                  "dates ARRAY<STRUCT<date: STRING, context: STRING>>, "
                  "events ARRAY<STRUCT<date: STRING, event_type: STRING, description: STRING>>")

_ctx = lambda value_type: {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                                        "properties": {value_type[0]: {"type": value_type[1]}, "context": {"type": "string"}},
                                                        "required": [value_type[0], "context"]}}
RESPONSE_FORMAT = json.dumps({
    "type": "json_schema",
    "json_schema": {
        "name": "evidence_extraction",
        "strict": True,
        "schema": {
            "type": "object", "additionalProperties": False,
            "properties": {
                "summary": {"type": "string"},
                "people": {"type": "array", "items": {"type": "string"}},
                "companies": {"type": "array", "items": {"type": "string"}},
                "accounts": {"type": "array", "items": {"type": "string"}},
                "amounts": _ctx(("value", "number")),
                "dates": _ctx(("date", "string")),
                "events": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                                     "properties": {"date": {"type": "string"}, "event_type": {"type": "string"},
                                                                    "description": {"type": "string"}},
                                                     "required": ["date", "event_type", "description"]}},
            },
            "required": ["summary", "people", "companies", "accounts", "amounts", "dates", "events"],
        },
    },
})

PROMPT = ("You assist an ASIC investigator. From the evidence document below, write a 2-3 sentence factual summary "
          "and extract the people, companies, bank accounts, monetary amounts in AUD with a short quoted context, "
          "dates as yyyy-MM-dd with context, and dated events (transaction, meeting, lodgement, notice, transfer, "
          "examination). Do not infer facts that are not in the text. Document: ")


@dp.table(comment="Evidence AI output per document (summary + structured extraction). AI output, status=suggested")
@dp.expect("extraction_succeeded", "ai_error IS NULL")
def silver_evidence_ai():
    endpoint = llm_endpoint()
    ai = (f"ai_query('{endpoint}', concat('{PROMPT}', substring(parsed_text, 1, 30000)), "
          f"responseFormat => '{RESPONSE_FORMAT}', failOnError => false)")
    return (spark.readStream.table("silver_evidence_parsed").filter("parse_ok")
            .select("evidence_id", "case_id", "sha256", F.expr(ai).alias("ai"))
            .select("evidence_id", "case_id", "sha256",
                    F.from_json("ai.result", EXTRACTION_DDL).alias("extraction"),
                    F.col("ai.errorMessage").alias("ai_error"),
                    F.lit(endpoint).alias("ai_model"), F.current_timestamp().alias("ai_generated_at"),
                    F.lit(True).alias("ai_flag")))
