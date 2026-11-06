"""Silver: ABN register (P11 ABN Bulk Extract). Entity-resolution backbone; GST cancellation is a distress signal.

XML attributes arrive with a '_' prefix and element text as '_VALUE' (e.g. <ABN status="ACT">123</ABN>).
"""
from pyspark import pipelines as dp
from pyspark.sql import functions as F


def _v(path, typ="string"):
    return f"try_variant_get(record, '{path}', '{typ}')"


@dp.materialized_view(comment="ABN register: ABN, status, ACN, entity type, name, state, GST status. provenance=public", cluster_by=["acn"])
@dp.expect_or_drop("valid_abn", "abn RLIKE '^[0-9]{11}$'")
def silver_abn_register():
    return (spark.read.table("bronze_p11_abn_bulk_extract")
            .select(
                F.expr(f"coalesce({_v('$.ABN._VALUE')}, {_v('$.ABN')})").alias("abn"),
                F.expr(_v("$.ABN._status")).alias("abn_status"),
                F.expr(f"try_to_date({_v('$.ABN._ABNStatusFromDate')}, 'yyyyMMdd')").alias("abn_status_from"),
                F.expr(f"lpad(coalesce({_v('$.ASICNumber._VALUE')}, {_v('$.ASICNumber')}), 9, '0')").alias("acn"),
                F.expr(_v("$.EntityType.EntityTypeText")).alias("entity_type"),
                F.expr(f"coalesce({_v('$.MainEntity.NonIndividualName.NonIndividualNameText')}, "
                       f"concat_ws(' ', {_v('$.LegalEntity.IndividualName.GivenName[0]')}, {_v('$.LegalEntity.IndividualName.FamilyName')}))").alias("name"),
                F.expr(f"coalesce({_v('$.MainEntity.BusinessAddress.AddressDetails.State')}, {_v('$.LegalEntity.BusinessAddress.AddressDetails.State')})").alias("state"),
                F.expr(f"coalesce({_v('$.MainEntity.BusinessAddress.AddressDetails.Postcode')}, {_v('$.LegalEntity.BusinessAddress.AddressDetails.Postcode')})").alias("postcode"),
                F.expr(_v("$.GST._status")).alias("gst_status"),
                F.expr(f"try_to_date({_v('$.GST._GSTStatusFromDate')}, 'yyyyMMdd')").alias("gst_status_from"),
                F.col("_snapshot").alias("snapshot"), "provenance")
            .withColumn("acn", F.when(F.col("acn").rlike("^[0-9]{9}$") & (F.col("acn") != "000000000"), F.col("acn"))))
