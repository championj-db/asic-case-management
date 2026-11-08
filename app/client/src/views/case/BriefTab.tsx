import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { api, useApi } from '../../lib/api';
import { dateTime, txt } from '../../lib/format';
import { AiLabel, Empty, ErrorState, SkeletonBlock, useSession, useToast, type Row } from '../../components/common';

type Status = 'Draft (AI)' | 'Edited' | 'Reviewed';
interface Section {
  title: string;
  body: string;
  status: Status;
}

const CITE = /\[(EV|EVT|SR|PPS|SCN|HM)(?::([^\]]+))?\]/g;

/** Renders citation tokens as chips and flags factual sentences that carry no citation (SPEC 8.6). */
function CitedText({ text, onCite }: { text: string; onCite: (kind: string, ref: string) => void }) {
  const paras = text.split(/\n{2,}/);
  return (
    <div className="brief-body">
      {paras.map((p, pi) => {
        const sentences = p.split(/(?<=[.!?])\s+(?=[A-Z(•\-*])/);
        return (
          <p key={pi}>
            {sentences.map((s, si) => {
              const nodes: ReactNode[] = [];
              let last = 0;
              let cited = false;
              for (const m of s.matchAll(CITE)) {
                cited = true;
                nodes.push(s.slice(last, m.index));
                const kind = m[1];
                const ref = m[2] ?? '';
                nodes.push(
                  <button key={`${si}-${m.index}`} className="citation" onClick={() => onCite(kind, ref)} title={`${kind}${ref ? ` ${ref}` : ''}`}>
                    {kind === 'PPS' ? 'PPS' : kind === 'SR' ? ref.split(':').pop() : `${kind}-${ref.replace(/^EV-/, '').slice(0, 10)}`}
                  </button>,
                );
                last = (m.index ?? 0) + m[0].length;
              }
              nodes.push(s.slice(last));
              const needsCite = !cited && s.trim().length > 40 && !/^(#|Recommendation:|Note:)/.test(s.trim());
              return (
                <span key={si} className={needsCite ? 'uncited' : undefined} title={needsCite ? 'No citation — verify or add a source before review' : undefined}>
                  {nodes}{' '}
                </span>
              );
            })}
          </p>
        );
      })}
    </div>
  );
}

export function BriefTab({ caseId }: { caseId: string }) {
  const { me } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const { data, error, loading, reload } = useApi<{ versions: Row[] }>(`/api/cases/${caseId}/brief`);
  const [sections, setSections] = useState<Section[] | null>(null);
  const [version, setVersion] = useState<Row | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const v = data?.versions[0];
    if (v && !dirty) {
      setVersion(v);
      setSections(v.sections as Section[]);
    }
  }, [data, dirty]);

  const generate = async () => {
    setStreaming('');
    setStatus('Assembling case, evidence, cross-agency and scenario context…');
    try {
      await api.stream(`/api/cases/${caseId}/brief/generate`, (e) => {
        if (e.type === 'status') setStatus(txt(e.message));
        if (e.type === 'delta') setStreaming((s) => (s ?? '') + txt(e.text));
        if (e.type === 'error') toast(txt(e.message));
        if (e.type === 'done') {
          setSections(e.sections as Section[]);
          setDirty(false);
          toast(`Draft v${txt(e.version)} saved · audited as AI generation`);
        }
      });
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setStreaming(null);
      reload();
    }
  };
  const save = async () => {
    if (!sections) return;
    try {
      const r = await api.post<Row>(`/api/cases/${caseId}/brief`, { sections });
      toast(`Saved as v${txt(r.version)} · audited`);
      setDirty(false);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const update = (i: number, patch: Partial<Section>) => {
    if (!sections) return;
    setSections(sections.map((s, j) => (j === i ? { ...s, ...patch } : s)));
    setDirty(true);
  };
  const onCite = (kind: string, ref: string) => {
    if (kind === 'EV') void nav(`/cases/${caseId}/evidence?doc=${ref}`);
    else if (kind === 'EVT') void nav(`/cases/${caseId}/timeline`);
    else if (kind === 'PPS' || kind === 'SCN') void nav(`/cases/${caseId}/scoring`);
    else if (kind === 'SR') void nav(`/entities/${ref.split(':')[0]}`);
    else toast(`Past matter ${ref} — see Entity 360 / historical matters`);
  };
  const exportDoc = async (format: 'html' | 'doc') => {
    if (!sections) return;
    const body = sections
      .map((s) => `<h2>${s.title}</h2><p><em>${s.status}</em></p>${s.body.split(/\n{2,}/).map((p) => `<p>${p.replace(/</g, '&lt;')}</p>`).join('')}`)
      .join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Case brief ${caseId}</title><style>body{font-family:Arial,sans-serif;max-width:760px;margin:40px auto;line-height:1.5}h2{border-bottom:1px solid #ccc}</style></head><body><p>OFFICIAL: Sensitive</p><h1>Prosecution recommendation — ${caseId}</h1><p>Version ${txt(version?.version ?? 'draft')} · exported ${new Date().toLocaleString('en-AU')} by ${me?.displayName}. AI-drafted sections are marked “Draft (AI)”.</p>${body}</body></html>`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([html], { type: format === 'doc' ? 'application/msword' : 'text/html' }));
    a.download = `${caseId}-brief-v${txt(version?.version ?? 'draft')}.${format}`;
    a.click();
    await api.post(`/api/cases/${caseId}/brief/export`, { version: version?.version, format }).catch(() => undefined);
  };

  if (error) return <ErrorState message={error} onRetry={reload} />;
  const canReview = me?.persona !== 'Investigator';
  const reviewed = sections?.filter((s) => s.status === 'Reviewed').length ?? 0;
  return (
    <section className="case-panel active" data-od-id="brief-panel">
      <div className="decision-bar">
        <div><h2>Case brief</h2><p>AI-assisted prosecution memo grounded in this case’s evidence, cross-agency data and scenarios, with mandatory citations.</p></div>
        <div className="header-actions">
          <button className="btn" onClick={generate} disabled={streaming !== null}>{streaming !== null ? 'Drafting…' : sections ? '✦ Regenerate draft' : '✦ Generate draft'}</button>
          {sections && <button className="btn" onClick={() => exportDoc('html')}>Export (print/PDF)</button>}
          {sections && <button className="btn primary" onClick={() => exportDoc('doc')}>Export brief (.doc)</button>}
        </div>
      </div>
      {loading && !data ? <section className="card"><SkeletonBlock rows={8} /></section> : streaming !== null ? (
        <section className="card">
          <div className="card-head"><h3>Drafting</h3><AiLabel>{status}</AiLabel></div>
          <div className="card-body"><div className="streaming" aria-live="polite">{streaming || '…'}</div></div>
        </section>
      ) : !sections ? (
        <section className="card">
          <Empty title="No brief yet" action={<button className="btn primary" onClick={generate}>✦ Generate draft</button>}>
            The draft cites evidence [EV], timeline events [EVT], shared-agency records [SR], the PPS and scenarios, and comparable past matters. Restricted AUSTRAC detail is only included if you are authorised.
          </Empty>
        </section>
      ) : (
        <div className="grid-main">
          <section className="card">
            <div className="card-head">
              <h3>Recommendation memo · v{txt(version?.version ?? '?')}{dirty ? ' (unsaved changes)' : ''}</h3>
              <span className="badge">{reviewed === sections.length ? 'Reviewed' : `${reviewed}/${sections.length} sections reviewed`}</span>
            </div>
            <div className="card-body">
              {version?.generated ? <AiLabel model={version.ai_model} at={version.created_at}>AI draft</AiLabel> : <span className="ai-label">Edited by {txt(version?.author_name ?? version?.author)} · {dateTime(version?.created_at)}</span>}
              <div className="brief-editor" style={{ marginTop: 12 }}>
                {sections.map((s, i) => (
                  <div className="brief-section" key={i}>
                    <div className="spread">
                      <h3>{s.title}</h3>
                      <div className="row">
                        <span className={`prov ${s.status === 'Draft (AI)' ? 'derived' : s.status === 'Reviewed' ? 'public' : ''}`}>{s.status}</span>
                        {editing === i ? <button className="btn sm" onClick={() => setEditing(null)}>Done</button> : <button className="btn sm ghost" onClick={() => setEditing(i)}>Edit</button>}
                        {canReview && s.status !== 'Reviewed' && <button className="btn sm" onClick={() => update(i, { status: 'Reviewed' })}>Mark reviewed</button>}
                      </div>
                    </div>
                    {editing === i ? (
                      <textarea value={s.body} onChange={(e) => update(i, { body: e.target.value, status: 'Edited' })} aria-label={`${s.title} text`} />
                    ) : (
                      <CitedText text={s.body} onCite={onCite} />
                    )}
                  </div>
                ))}
              </div>
              <div className="scenario-actions">
                <button className="btn primary" disabled={!dirty} onClick={save}>Save new version</button>
              </div>
              <p className="note">Highlighted sentences have no citation. Counsel or a lead marks sections Reviewed; investigators can edit.</p>
            </div>
          </section>
          <aside className="card">
            <div className="card-head"><h3>Version history</h3></div>
            <div className="card-body list">
              {data?.versions.map((v) => (
                <button key={txt(v.version)} className="list-item link" style={{ textDecoration: 'none', width: '100%', textAlign: 'left' }} onClick={() => { setVersion(v); setSections(v.sections as Section[]); setDirty(false); }}>
                  <div><strong>v{txt(v.version)} {v.generated ? '· ✦ AI draft' : '· edited'}</strong><small>{txt(v.author_name ?? v.author)} · {dateTime(v.created_at)}</small></div>
                  {version?.version === v.version ? <span className="badge">Open</span> : null}
                </button>
              ))}
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
