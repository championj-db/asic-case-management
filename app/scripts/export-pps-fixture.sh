#!/usr/bin/env bash
# Exports the batch PPS (pps_score, scenario, pps_params, weights, presets) to tests/fixtures/pps_parity.json so the
# vitest parity test can prove the browser engine reproduces SQL pps_compute. Re-run after every scoring job.
# Usage: scripts/export-pps-fixture.sh <profile> <warehouse_id> [catalog] [schema]
set -euo pipefail
PROFILE=${1:?profile}; WH=${2:?warehouse id}; CATALOG=${3:-au_pubsec_catalog}; SCHEMA=${4:-asic_case_management}
OUT="$(dirname "$0")/../tests/fixtures/pps_parity.json"
mkdir -p "$(dirname "$OUT")"
python3 - "$PROFILE" "$WH" "$CATALOG.$SCHEMA" "$OUT" <<'PY'
import json, subprocess, sys
profile, wh, fq, out = sys.argv[1:]
def q(sql):
    r = subprocess.run(["databricks", "api", "post", "/api/2.0/sql/statements", "--profile", profile, "--json",
                        json.dumps({"warehouse_id": wh, "statement": sql, "wait_timeout": "50s"})], capture_output=True, text=True, check=True)
    d = json.loads(r.stdout)
    assert d["status"]["state"] == "SUCCEEDED", d["status"]
    cols = [c["name"] for c in d["manifest"]["schema"]["columns"]]
    return [dict(zip(cols, row)) for row in d.get("result", {}).get("data_array", [])]
params = q(f"SELECT params_version, params_json FROM {fq}.pps_params")[0]
w = q(f"SELECT w_financial, w_success, w_harm, w_deterrence, w_urgency FROM {fq}.scoring_weights")[0]
presets = q(f"SELECT * FROM {fq}.intervention_presets")
fl = lambda v: None if v is None else float(v)
fixture = {
    "params_version": params["params_version"],
    "params": json.loads(params["params_json"]),
    "weights": {k: float(v) for k, v in w.items()},
    "presets": [{"preset_id": p["preset_id"], "name": p["name"], "cost_multiplier": fl(p["cost_multiplier"]),
                 "duration_multiplier": fl(p["duration_multiplier"]), "p_collapse_override": fl(p["p_collapse_override"]),
                 "p_success_override": fl(p["p_success_override"]), "recoverable_multiplier": fl(p["recoverable_multiplier"])} for p in presets],
    "cases": [{"case_id": r["case_id"], "total": float(r["total"]), "band": r["band"], "inputs": json.loads(r["inputs_json"]),
               "criteria": json.loads(r["criteria_json"])} for r in q(f"SELECT case_id, total, band, inputs_json, criteria_json FROM {fq}.pps_score ORDER BY case_id")],
    "scenarios": [{"case_id": r["case_id"], "preset_id": r["preset_id"], "inputs": json.loads(r["inputs_json"]), "outputs": json.loads(r["outputs_json"])}
                  for r in q(f"SELECT case_id, preset_id, inputs_json, outputs_json FROM {fq}.scenario ORDER BY case_id, preset_id")],
}
json.dump(fixture, open(out, "w"), indent=1)
print(f"wrote {out}: {len(fixture['cases'])} cases, {len(fixture['scenarios'])} scenarios, {fixture['params_version']}")
PY
