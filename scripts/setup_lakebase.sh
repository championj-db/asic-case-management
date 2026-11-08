#!/usr/bin/env bash
# One-time (idempotent) Lakebase setup for the app: project, UC catalog registration, synced tables.
# DABs cannot yet express Lakebase Autoscaling projects/synced tables (postgres_synced_tables is not available),
# so this script is the source of truth. Re-running it skips anything that already exists.
# Usage: scripts/setup_lakebase.sh <profile> [catalog] [schema]
#   ONLY="tbl1 tbl2" limits creation to those source tables; SKIP="tbl1 tbl2" skips them.
set -euo pipefail
PROFILE=${1:?profile}; CATALOG=${2:-au_pubsec_catalog}; SCHEMA=${3:-asic_case_management}
PROJECT=asic-case-management; BRANCH=projects/$PROJECT/branches/production
CFG="$(dirname "$0")/../config/lakebase_synced_tables.json"
LB_CATALOG=$(python3 -c "import json;print(json.load(open('$CFG'))['lakebase_catalog'])")
PG_SCHEMA=$(python3 -c "import json;print(json.load(open('$CFG'))['postgres_schema'])")

databricks postgres get-project projects/$PROJECT --profile "$PROFILE" >/dev/null 2>&1 || \
  databricks postgres create-project $PROJECT --json '{"spec": {"display_name": "ASIC Intelligent Case Management"}}' --profile "$PROFILE"
databricks postgres get-catalog catalogs/$LB_CATALOG --profile "$PROFILE" >/dev/null 2>&1 || \
  databricks postgres create-catalog $LB_CATALOG --json "{\"spec\": {\"postgres_database\": \"databricks_postgres\", \"branch\": \"$BRANCH\"}}" --profile "$PROFILE"

python3 - "$CFG" <<'PY' | while IFS=$'\t' read -r SRC PK; do
import json,sys
for t in json.load(open(sys.argv[1]))["tables"]: print(t["source"], json.dumps(t["pk"]), sep="\t")
PY
  if [ -n "${ONLY:-}" ] && [[ " $ONLY " != *" $SRC "* ]]; then continue; fi
  if [ -n "${SKIP:-}" ] && [[ " $SKIP " == *" $SRC "* ]]; then continue; fi
  ID="$LB_CATALOG.$PG_SCHEMA.$SRC"
  if databricks postgres get-synced-table "synced_tables/$ID" --profile "$PROFILE" >/dev/null 2>&1; then
    echo "exists  $ID"; continue
  fi
  echo "create  $ID"
  databricks postgres create-synced-table "$ID" --no-wait --profile "$PROFILE" --json "{\"spec\": {
    \"source_table_full_name\": \"$CATALOG.$SCHEMA.$SRC\", \"primary_key_columns\": $PK, \"scheduling_policy\": \"SNAPSHOT\",
    \"branch\": \"$BRANCH\", \"postgres_database\": \"databricks_postgres\", \"create_database_objects_if_missing\": true,
    \"new_pipeline_spec\": {\"storage_catalog\": \"$CATALOG\", \"storage_schema\": \"$SCHEMA\"}}}" >/dev/null
done
