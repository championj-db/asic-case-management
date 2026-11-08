import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { api, useApi } from '../../lib/api';
import { dateTime, shortDate, txt } from '../../lib/format';
import { AiLabel, Empty, ErrorState, Prov, SkeletonBlock, useToast, type Row } from '../../components/common';

interface Detail {
  item: Row;
  extractions: Row[];
  custody: Row[];
  tags: Row[];
}

const KIND_LABEL: Record<string, string> = { entity_person: 'Person', entity_company: 'Company', account: 'Account', amount: 'Amount', date: 'Date', event: 'Event' };

/** Renders parsed text with extraction spans highlighted; overlapping spans are skipped (first wins). */
function Highlighted({ text, spans, focus }: { text: string; spans: Row[]; focus: string | null }) {
  const parts: ReactNode[] = [];
  const sorted = spans
    .filter((s) => s.span_start !== null && s.span_start !== undefined && s.span_end !== null)
    .sort((a, b) => Number(a.span_start) - Number(b.span_start));
  let pos = 0;
  for (const s of sorted) {
    const a = Number(s.span_start);
    const b = Number(s.span_end);
    if (a < pos || b > text.length) continue;
    parts.push(text.slice(pos, a));
    parts.push(
      <mark key={txt(s.extraction_id)} id={`x-${txt(s.extraction_id)}`} className={`${txt(s.status)}${focus === s.extraction_id ? ' focus' : ''}`} title={`${KIND_LABEL[txt(s.kind)] ?? txt(s.kind)} · ${txt(s.status)}`}>
        {text.slice(a, b)}
      </mark>,
    );
    pos = b;
  }
  parts.push(text.slice(pos));
  return <pre>{parts}</pre>;
}

export function EvidenceTab({ caseId }: { caseId: string }) {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const list = useApi<{ items: Row[] }>(`/api/cases/${caseId}/evidence`);
  const tagList = useApi<{ tags: { tag: string; category: string }[] }>('/api/evidence-tags');
  const items = list.data?.items ?? [];
  const sel = params.get('doc') ?? (items[0] ? txt(items[0].evidence_id) : null);
  const isUpload = Boolean(sel?.startsWith('UP-'));
  const detail = useApi<Detail>(sel && !isUpload ? `/api/evidence/${sel}` : null);
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'keyword' | 'semantic'>('semantic');
  const [results, setResults] = useState<Row[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [tagFilter, setTagFilter] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<Row | null>(null);
  const [asking, setAsking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setFocus(null), [sel]);
  useEffect(() => {
    if (focus) document.getElementById(`x-${focus}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focus]);

  const select = (id: string) => setParams({ doc: id }, { replace: true });
  const visible = useMemo(() => items.filter((i) => !tagFilter || ((i.tags as string[]) ?? []).includes(tagFilter)), [items, tagFilter]);

  const search = async () => {
    if (q.trim().length < 2) {
      setResults(null);
      return;
    }
    setSearching(true);
    try {
      const r = await api.get<{ results: Row[] }>(`/api/cases/${caseId}/evidence/search?q=${encodeURIComponent(q)}&mode=${mode}`);
      setResults(r.results);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSearching(false);
    }
  };
  const review = async (x: Row, status: 'confirmed' | 'rejected') => {
    try {
      await api.post(`/api/extractions/${txt(x.extraction_id)}/review`, { status });
      detail.reload();
      list.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const toggleTag = async (tag: string, on: boolean) => {
    if (!sel) return;
    try {
      await api.post(`/api/evidence/${sel}/tags`, { tag, on });
      detail.reload();
      list.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const ask = async () => {
    setAsking(true);
    try {
      setAnswer(await api.post<Row>(`/api/cases/${caseId}/evidence/ask`, { question }));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setAsking(false);
    }
  };
  const upload = async (f: File) => {
    try {
      const r = await api.upload<Row>(`/api/cases/${caseId}/evidence/upload`, f);
      toast(`Uploaded ${txt(r.filename)} · SHA-256 ${txt(r.sha256).slice(0, 12)}… recorded`);
      list.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const d = detail.data;
  const tags = new Set((d?.tags ?? []).map((t) => txt(t.tag)));
  const pending = (d?.extractions ?? []).filter((x) => x.status === 'suggested');
  return (
    <section className="case-panel active" data-od-id="evidence-review-panel">
      <div className="decision-bar">
        <div><h2>Evidence review</h2><p>Search, review, code and confirm AI extractions while preserving chain of custody. Only confirmed items reach the Timeline.</p></div>
        <div className="header-actions">
          <input ref={fileRef} type="file" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <button className="btn primary" onClick={() => fileRef.current?.click()}>Upload evidence</button>
        </div>
      </div>
      {list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : (
        <section className="card document-grid">
          <aside className="doc-list">
            <div className="row" style={{ gap: 6 }}>
              <input className="number" style={{ flex: 1 }} placeholder={mode === 'semantic' ? 'Ask by meaning, e.g. “transfer to related entity”' : 'Exact words'} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} aria-label="Search evidence" />
            </div>
            <div className="spread" style={{ marginTop: 8 }}>
              <div className="search-mode" role="group" aria-label="Search mode">
                <button className={mode === 'semantic' ? 'on' : ''} onClick={() => setMode('semantic')} aria-pressed={mode === 'semantic'}>Semantic</button>
                <button className={mode === 'keyword' ? 'on' : ''} onClick={() => setMode('keyword')} aria-pressed={mode === 'keyword'}>Keyword</button>
              </div>
              <button className="btn sm" onClick={search} disabled={searching}>{searching ? 'Searching…' : 'Search'}</button>
            </div>
            <select className="select" style={{ width: '100%', marginTop: 8 }} value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} aria-label="Filter by tag">
              <option value="">All documents ({items.length})</option>
              {(tagList.data?.tags ?? []).map((t) => <option key={t.tag} value={t.tag}>{t.tag}</option>)}
            </select>
            <div className="doc-list-scroll">
              {results ? (
                <>
                  <div className="spread small"><span className="muted">{results.length} passages · {mode}</span><button className="link small" onClick={() => setResults(null)}>Clear</button></div>
                  {results.length === 0 && <p className="note">No passages found.</p>}
                  {results.map((r, i) => (
                    <div key={i} className={`list-item${sel === r.evidence_id ? ' active' : ''}`} onClick={() => select(txt(r.evidence_id))} style={{ display: 'block' }}>
                      <strong>{txt(r.filename ?? r.evidence_id)}</strong>
                      <small className="muted" style={{ display: 'block' }}>{txt(r.passage ?? '').slice(0, 180)}…</small>
                      {r.score !== null && r.score !== undefined && <small className="mono muted">score {Number(r.score).toFixed(2)}</small>}
                    </div>
                  ))}
                </>
              ) : list.loading && !list.data ? <SkeletonBlock rows={6} /> : visible.length === 0 ? <Empty title="No documents" /> : (
                <div className="list">
                  {visible.map((i) => (
                    <div key={txt(i.evidence_id)} className={`list-item${sel === i.evidence_id ? ' active' : ''}`} onClick={() => select(txt(i.evidence_id))} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && select(txt(i.evidence_id))}>
                      <div>
                        <strong>{txt(i.filename)}</strong>
                        <small>{txt(i.doc_type)}{((i.tags as string[]) ?? []).length ? ` · ${((i.tags as string[]) ?? []).join(', ')}` : ''}</small>
                      </div>
                      <span className="small muted">{Number(i.pending) > 0 ? `✦ ${txt(i.pending)}` : i.page_count ? `${txt(i.page_count)}p` : ''}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
          <div className="doc-viewer">
            {isUpload ? (
              <article className="paper"><Empty title="Uploaded original stored in the evidence volume">Parsing and AI extraction run on the next pipeline refresh. The SHA-256 taken on upload is in the custody log.</Empty></article>
            ) : detail.loading && !d ? <article className="paper"><SkeletonBlock rows={10} /></article> : detail.error ? <ErrorState message={detail.error} onRetry={detail.reload} /> : d ? (
              <article className="paper">
                <div className="spread">
                  <span className="ai-label">{txt(d.item.doc_type)} · {txt(d.item.page_count ?? '?')} pages · {shortDate(d.item.document_date)}</span>
                  <Prov p={d.item.provenance} />
                </div>
                <h2 style={{ margin: '20px 0' }}>{txt(d.item.filename)}</h2>
                <Highlighted text={txt(d.item.parsed_text ?? 'No parsed text available.')} spans={d.extractions} focus={focus} />
              </article>
            ) : <Empty title="Select a document" />}
          </div>
          <aside className="doc-review">
            <h3>Review</h3>
            {d && !isUpload ? (
              <div className="stack" style={{ marginTop: 12 }}>
                <div>
                  <span className="ai-label">Tags · coding</span>
                  <div className="tag-row" style={{ marginTop: 6 }}>
                    {(tagList.data?.tags ?? []).map((t) => (
                      <button key={t.tag} className={`tag${tags.has(t.tag) ? ' on' : ''}`} aria-pressed={tags.has(t.tag)} onClick={() => toggleTag(t.tag, !tags.has(t.tag))}>{t.tag}</button>
                    ))}
                  </div>
                </div>
                {d.item.ai_summary ? (
                  <div className="ai-panel">
                    <AiLabel model={d.item.ai_model} at={d.item.ai_generated_at}>Summary</AiLabel>
                    <p style={{ marginTop: 6 }}>{txt(d.item.ai_summary)}</p>
                  </div>
                ) : null}
                <div>
                  <div className="spread"><span className="ai-label">✦ Suggested extractions · {pending.length} to review</span></div>
                  <div className="list">
                    {d.extractions.length === 0 && <p className="note">No extractions for this document.</p>}
                    {d.extractions.map((x) => (
                      <div className="list-item" key={txt(x.extraction_id)} onMouseEnter={() => setFocus(txt(x.extraction_id))}>
                        <div>
                          <strong>{txt(x.value).slice(0, 80)}</strong>
                          <small>{KIND_LABEL[txt(x.kind)] ?? txt(x.kind)}{x.span_start === null ? ' · not located in text' : ''} · {x.status === 'suggested' ? 'suggested' : `${txt(x.status)} by ${txt(x.reviewer_name ?? x.reviewer)}`}</small>
                        </div>
                        {x.status === 'suggested' ? (
                          <div className="row" style={{ flexWrap: 'nowrap' }}>
                            <button className="btn sm" onClick={() => review(x, 'confirmed')} aria-label={`Confirm ${txt(x.value)}`}>Confirm</button>
                            <button className="btn sm ghost" onClick={() => review(x, 'rejected')} aria-label={`Reject ${txt(x.value)}`}>Reject</button>
                          </div>
                        ) : (
                          <button className="btn sm ghost" onClick={() => review(x, x.status === 'confirmed' ? 'rejected' : 'confirmed')}>Undo</button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <span className="ai-label">Chain of custody</span>
                  <p className="small" style={{ marginTop: 4 }}>
                    SHA-256 {txt(d.item.sha256).slice(0, 16)}… {d.item.hash_verified ? '· verified against creation hash' : '· ⚠ hash mismatch'} · {txt(d.item.source)} · custodian {txt(d.item.custodian)}
                  </p>
                  <div className="list">
                    {d.custody.map((c, i) => (
                      <div className="list-item" key={i}><div><strong>{txt(c.action)}</strong><small>{txt(c.actor)}</small></div><small className="mono">{dateTime(c.at)}</small></div>
                    ))}
                  </div>
                </div>
              </div>
            ) : <p className="note">Select a document to review.</p>}
            <div className="ai-panel" style={{ marginTop: 16 }}>
              <span className="ai-label">✦ Ask this case’s evidence</span>
              <textarea className="number" style={{ marginTop: 8, minHeight: 64 }} placeholder="e.g. When were funds moved to related entities?" value={question} onChange={(e) => setQuestion(e.target.value)} aria-label="Question about the evidence" />
              <div className="scenario-actions"><button className="btn sm" disabled={asking || question.trim().length < 3} onClick={ask}>{asking ? 'Reading evidence…' : 'Ask'}</button></div>
              {answer && (
                <div style={{ marginTop: 8 }}>
                  <AiLabel model={answer.model} at={answer.generated_at}>Answer · cites evidence</AiLabel>
                  <p style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
                    {txt(answer.answer).split(/(\[EV-[^\]]+\])/g).map((part, i) =>
                      /^\[EV-/.test(part) ? <button key={i} className="citation" onClick={() => select(part.slice(1, -1))}>{part.slice(1, -1)}</button> : part,
                    )}
                  </p>
                </div>
              )}
            </div>
          </aside>
        </section>
      )}
    </section>
  );
}
