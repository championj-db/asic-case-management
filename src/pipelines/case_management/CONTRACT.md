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
| `silver_relationship` | from_entity, to_entity, rel_type (director_of, secretary_of, shares_name, shares_address, licensed_as), source, valid_from, valid_to |
| `silver_evidence_parsed` | evidence_id, case_id, path, sha256, parsed_text (ai_parse_document), page_count |
| `silver_evidence_ai` | evidence_id, case_id, extraction (summary, people, companies, accounts, amounts, dates, events), ai_model, ai_generated_at |
| `silver_evidence_extraction` | evidence_id, kind (entity/event/amount/date/account), value, span, status = 'suggested', model, generated_at |
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

**`gold_evidence_item`**: evidence_id, case_id, filename, sha256, source, custodian, ingested_at, ai_summary, ai_model.

**`gold_custody_event`**: evidence_id, actor, action (ingested/parsed), event_ts, hash_after.

**`gold_case_event`**: event_id, case_id, event_date, event_type, description, evidence_ids, entity_ids, status (suggested/confirmed).

**`gold_entity_profile`**: entity_id, the 360 panel fields (ASIC, licences, ATO, APRA, AUSTRAC count only, AFCA, sanctions match, banned match, open cases), sources_count.

**`gold_entity_network`**: from_entity, to_entity, rel_type, weight, hop-ready edges for depth-2 neighbourhoods.

## Tables written by notebooks (not the pipeline)
`risk_score`, `pps_score`, `scoring_weights`, `intervention_presets`, `scenario`, SQL function `pps_compute`, index `evidence_chunks_index`.
