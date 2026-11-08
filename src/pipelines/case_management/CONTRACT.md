# Medallion table contract - asic-case-management pipeline

The SDP pipeline (`transformations/`) turns raw files into the tables below. Downstream notebooks 04-06 and the app rely on these **names and columns**. Every table carries `provenance` (`public`, `synthetic`, `de-identified`, or `derived`).

Pipeline configuration keys: `catalog`, `schema`, `raw_volume_path`, `evidence_volume_path`, `llm_endpoint`, `curated_slice_size`.

## Inputs (written by notebooks 01-03)
* `${raw_volume_path}/public/<source_id>/snapshot=<yyyymmdd>/` - unchanged public files plus `_manifest.json`. Source ids: p01_asic_companies (tab-delimited `.csv`), p02_asic_business_names, p03_asic_afs_licensees, p03_asic_credit_licensees, p04_asic_banned_persons, p04_asic_banned_orgs, p05_asic_liquidators (`.tsv`), p06_asic_insolvency_stats, p12_ato_tax_transparency, p13_apra_super_stats, p14_apra_adi_stats, p17_dfat_sanctions (`.xlsx`), p10_open_au_legal_corpus (`asic_judgments.jsonl`), p11_abn_bulk_extract (`.xml`), p18_acnc_register (`.csv`).
* `${raw_volume_path}/synthetic/<dataset>/` (parquet): curated_slice, persons, directorships, ato_tax_profile, austrac_smr, apra_prudential_flags, afca_complaints, enforcement_alternatives, published_notices, breach_reports, historical_matters, teams, users, cases, case_parties, evidence_manifest.
* `${evidence_volume_path}/<case_id>/<evidence_id>_<type>.pdf` - evidence documents.

## Bronze
One table per source, `bronze_<source_id>` / `bronze_syn_<dataset>`. Raw columns plus `_snapshot`, `_source_file`, `_ingested_at`, `provenance`. Keep every snapshot, because status history drives the collapse labels. `bronze_evidence_files`: binary content, path, size, `sha256` computed at ingest.

## Silver (cleaned, typed, resolved)
| Table | Key columns |
|---|---|
| `silver_company` | acn, abn, company_name, type, status, reg_date, dereg_date, snapshot; current row per ACN; whole register |
| `silver_company_status_history` | acn, status, valid_from, valid_to (from snapshots and dereg dates) |
| `silver_company_collapse` | acn, collapse_status, collapse_date, date_source (first EXAD/DRGD; collapse-model target) |
| `silver_abn_register` | abn, abn_status, acn, entity_type, name, state, postcode, gst_status (P11) |
| `silver_ato_tax_transparency` | name, abn, acn, total_income_aud, taxable_income_aud, tax_payable_aud, income_year (P12, real) |
| `silver_sanctions_list` | reference, sanction_ref, name, name_norm, party_type, name_type, date_of_birth, citizenship, committees (P17) |
| `silver_licensee` | licence_no, licence_type (AFS/credit), holder_name, acn, abn, status, start_date, end_date |
| `silver_banned_party` | name, party_type (person/org), ban_type, start_date, end_date, locality, state |
| `silver_person` | person_id, given_name, family_name, dob, state, postcode |
| `silver_directorship` | person_id, acn, role, appointed_date, ceased_date |
| `silver_ato_profile`, `silver_austrac_smr`, `silver_apra_flag`, `silver_afca_complaints`, `silver_enforcement_alternative`, `silver_published_notice`, `silver_breach_report` | typed versions of the synthetic datasets, keyed by acn |
| `silver_historical_matters` | synthetic historical_matters UNION real matters extracted from P10 judgments (parties, acn when matched, sections, outcome, penalty, filed/judgment dates). Column `source` = synthetic or judgment |
| `silver_entity` | entity_id, entity_type (company/person/trust/licensee), name, abn_acn, status, match_confidence |
| `silver_source_record` | source_record_id, entity_id, agency (ASIC/ATO/APRA/AUSTRAC/AFCA/DFAT/ACNC/ABR), source_table, source_key, match_score, loaded_at |
| `silver_resolution_review` | candidate pairs with match_score between 0.6 and 0.9 (auto-merge at 0.9 or above) |
| `silver_relationship` | from_entity, to_entity, rel_type (director_of, secretary_of, shares_business_name), source, valid_from, valid_to |
| `silver_evidence_parsed` | evidence_id, case_id, path, sha256, parsed_text (ai_parse_document), page_count |
| `silver_evidence_ai` | evidence_id, case_id, extraction (summary, people, companies, accounts, amounts, dates, events), ai_model, ai_generated_at |
| `silver_evidence_extraction` | extraction_id, evidence_id, case_id, kind (entity_person/entity_company/account/amount/date/event), value, span, span_start, span_end (offsets in parsed_text), event_date, status = 'suggested', model, generated_at, provenance=derived. Review state lives in the app (Lakebase `case_app.extraction_review`) |
| `silver_judgment_matters` | LLM-extracted facts per ASIC v ... judgment (respondents, provisions, outcome, penalty, dates) |
| `person_banned_match_candidates` (temporary view) | person <-> banned-register candidates with match_score and reasons |

## Gold (consumed by notebooks 04-06 and the app)
**`gold_entity_features`**: one row per (entity_id, as_of_date), companies in the curated slice. Labels are only set where the full horizon has been observed; no feature may use data after as_of_date.

| Column | Meaning |
|---|---|
| entity_id, acn, as_of_date | keys |
| company_age_years, is_licensee | ASIC |
| ato_debt_latest_aud, ato_debt_trend_6m_pct, lodgement_on_time_pct, stp_headcount_trend_pct, gst_cancelled | ATO |
| smr_count_24m, large_flow_smr_count_24m | AUSTRAC (restricted) |
| apra_flag_count | APRA |
| afca_complaints_latest, afca_complaints_trend_pct | AFCA |
| breach_reports_12m, enforcement_alternatives_count, banned_director_count | ASIC |
| director_prior_failed_companies, related_collapsed_entities | network |
| label_collapse_12m, label_collapse_24m | 1 if EXAD/DRGD within horizon after as_of_date, else 0, else null |

**`gold_case_inputs`**: one row per open case: case_id, case_number, title, case_type, stage, team_id, lead_user, respondent_entity_id, respondent_acn, est_recoverable_aud, est_litigation_cost_aud, est_duration_months, cost_to_date_aud, consumers_affected, total_consumer_loss_aud, vulnerable_cohort, strategic_priority_score, counsel_evidence_strength, evidence_element_coverage (0-1 share of the offence elements covered by tagged evidence, null if none), limitation_date, recent_smr_flag, story_tag.

**`gold_evidence_chunks`** (Change Data Feed enabled, for Vector Search): chunk_id (primary key), evidence_id, case_id, doc_type, chunk_index, chunk_text, source_system, provenance.

**`gold_evidence_item`**: evidence_id, case_id, filename, doc_type, sha256, sha256_at_creation, hash_verified, source, custodian, document_date, ingested_at, bytes, ai_summary, ai_model, ai_generated_at, parsed_text, page_count, provenance.

**`gold_custody_event`**: custody_event_id, evidence_id, actor, action (created/ingested/parsed/ai_extracted), event_ts, hash_after, provenance. App-side views/exports/uploads: `case_app.custody_access`.

**`gold_case_event`**: event_id, case_id, event_date, event_type, description, evidence_ids, entity_ids, status (suggested/confirmed), source, ai_flag, provenance.

**`gold_entity_profile`**: entity_id, the 360 panel fields (ASIC, licences, ATO, APRA, AUSTRAC count only, AFCA, sanctions match, possible banned-director matches, open cases), source_record_count, and per field-group provenance (asic_/abr_/ato_/ato_tt_/apra_/austrac_/afca_/sanctions_provenance).

**`gold_entity_network`**: from_entity, to_entity, rel_type (officer_of, shares_director, co_director, shares_business_name, possible_match), weight, provenance; hop-ready edges for depth-2 neighbourhoods.

**`gold_case_party`**: case_id, entity_id (CO-<acn> / PE-<person_id>), entity_name, entity_type, party_kind, role (respondent, witness, related = shares a director with the respondent), source, provenance.

**`gold_case_budget`** / **`gold_case_spend`**: approved budget per case and category; monthly spend per case and category summing to cost_to_date (synthetic, deterministic). `gold_case_inputs` also carries approved_budget_aud.

Identity matches between 0.6 and 0.9 never feed features or scores; they surface only in Resolution Review.

## Tables written by notebooks (not the pipeline)
* 04: `collapse_calibration` (Platt a/b per horizon and model version, population rate from P1, ECE/Brier before and after).
* 05: `risk_score` (calibrated P12; P24 = 1 − (1 − P12)²; `risk_status` Active/Collapsed with `collapse_status`, `collapse_date`; collapsed entities have null probabilities and band `Collapsed`) and `risk_score_history` (per quarterly as-of; drivers carry agency + restricted flags), `scoring_weights`, `pps_params` (every PPS constant incl. fitted P(success) coefficients, versioned), `intervention_presets`, `pps_score` and `pps_score_history` (with inputs_json, as_of_date, params_version), `scenario`, SQL function `pps_compute`.
* 06: index `evidence_chunks_index`.
* 07: `is_austrac_authorised()`, views `secure_austrac_smr` and `secure_entity_austrac` (the app queries these on behalf of the user).
* 08: refreshes the Lakebase synced tables listed in `config/lakebase_synced_tables.json` (created once by `scripts/setup_lakebase.sh`).
