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

const INLINE = /\[(EV|EVT|SR|PPS|SCN|HM)(?::([^\]]+))?\]|\*\*(.+?)\*\*|\*(?!\s)(.+?)\*/g;

const CITE = /\[(EV|EVT|SR|PPS|SCN|HM)(?::([^\]]+))?\]/;
type OnCite = (kind: string, ref: string) => void;

/** Inline markdown (bold, italic, nested) with citation chips. */
function Inline({ text, onCite, k = '' }: { text: string; onCite: OnCite; k?: string }) {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    nodes.push(text.slice(last, m.index));
    const key = `${k}-${m.index}`;
    if (m[1]) {
      const kind = m[1];
      const ref = m[2] ?? '';
      nodes.push(
        <button key={key} className="citation" onClick={() => onCite(kind, ref)} title={`${kind}${ref ? ` ${ref}` : ''}`}>
          {kind === 'PPS' ? 'PPS' : kind === 'SR' ? ref.split(':').pop() : `${kind}-${ref.replace(/^EV-/, '').slice(0, 10)}`}
        </button>,
      );
    } else if (m[3]) nodes.push(<strong key={key}><Inline text={m[3]} onCite={onCite} k={key} /></strong>);
    else if (m[4]) nodes.push(<em key={key}><Inline text={m[4]} onCite={onCite} k={key} /></em>);
    last = (m.index ?? 0) + m[0].length;
  }
  nodes.push(text.slice(last));
  return <>{nodes}</>;
}

/** Splits into sentences and flags factual sentences that carry no citation (SPEC 8.6). */
function Sentences({ text, onCite }: { text: string; onCite: OnCite }) {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z(*])/);
  return (
    <>
      {sentences.map((s, si) => {
        const plain = s.replace(new RegExp(CITE.source, 'g'), '').replace(/\*/g, '').trim();
        const needsCite = !CITE.test(s) && plain.length > 40 && !/^(Recommendation|Note|Proceed|Consider|Do not pursue)\b/.test(plain);
        return (
          <span key={si} className={needsCite ? 'uncited' : undefined} title={needsCite ? 'No citation — verify or add a source before review' : undefined}>
            <Inline text={s} onCite={onCite} k={String(si)} />{' '}
          </span>
        );
      })}
    </>
  );
}

type Block = { kind: 'p' | 'h' | 'ul' | 'ol' | 'table'; lines: string[] };

const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isRule = (row: string) => cells(row).every((c) => /^:?-{2,}:?$/.test(c));

/** Table rows from a markdown table block: header (when a |---| rule follows the first row) and body rows. */
function tableRows(lines: string[]) {
  const hasHead = lines.length > 1 && isRule(lines[1]);
  const rows = lines.filter((l) => !isRule(l)).map(cells);
  return { head: hasHead ? rows[0] : null, body: hasHead ? rows.slice(1) : rows };
}

/** Block markdown the model uses: paragraphs, sub-headings, bullet and numbered lists, tables. Rules (---) are dropped. */
function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const prev = blocks[blocks.length - 1];
    if (!line || /^[-*_]{3,}$/.test(line)) {
      if (prev && prev.kind === 'p') blocks.push({ kind: 'p', lines: [] });
      continue;
    }
    if (line.startsWith('|')) {
      if (prev?.kind === 'table') prev.lines.push(line);
      else blocks.push({ kind: 'table', lines: [line] });
      continue;
    }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    const ul = line.match(/^[-*•]\s+(.*)$/);
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (h) blocks.push({ kind: 'h', lines: [h[1]] });
    else if (ul) {
      if (prev?.kind === 'ul') prev.lines.push(ul[1]);
      else blocks.push({ kind: 'ul', lines: [ul[1]] });
    } else if (ol) {
      if (prev?.kind === 'ol') prev.lines.push(ol[1]);
      else blocks.push({ kind: 'ol', lines: [ol[1]] });
    }
    else if (prev?.kind === 'p') prev.lines.push(line);
    else blocks.push({ kind: 'p', lines: [line] });
  }
  return blocks.filter((b) => b.lines.length);
}

function CitedText({ text, onCite }: { text: string; onCite: OnCite }) {
  return (
    <div className="brief-body">
      {toBlocks(text).map((b, i) => {
        if (b.kind === 'h') return <h4 key={i}><Inline text={b.lines[0]} onCite={onCite} /></h4>;
        if (b.kind === 'table') {
          const t = tableRows(b.lines);
          return (
            <div key={i} className="brief-table">
              <table>
                {t.head && <thead><tr>{t.head.map((c, j) => <th key={j}><Inline text={c} onCite={onCite} /></th>)}</tr></thead>}
                <tbody>{t.body.map((r, j) => <tr key={j}>{r.map((c, x) => <td key={x}><Inline text={c} onCite={onCite} /></td>)}</tr>)}</tbody>
              </table>
            </div>
          );
        }
        if (b.kind === 'ul' || b.kind === 'ol') {
          const items = b.lines.map((l, j) => <li key={j}><Sentences text={l} onCite={onCite} /></li>);
          return b.kind === 'ul' ? <ul key={i}>{items}</ul> : <ol key={i}>{items}</ol>;
        }
        return <p key={i}><Sentences text={b.lines.join(' ')} onCite={onCite} /></p>;
      })}
    </div>
  );
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline markdown to HTML for export: bold, italic and citation tokens as compact bracketed references. */
function inlineHtml(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    out += esc(text.slice(last, m.index));
    if (m[1]) {
      const ref = m[2] ?? '';
      const label = m[1] === 'PPS' ? 'PPS' : m[1] === 'SR' ? `SR ${ref.split(':').pop()}` : `${m[1]}-${ref.replace(/^EV-/, '')}`;
      out += `<span class="cite">[${esc(label)}]</span>`;
    } else if (m[3]) out += `<strong>${inlineHtml(m[3])}</strong>`;
    else if (m[4]) out += `<em>${inlineHtml(m[4])}</em>`;
    last = (m.index ?? 0) + m[0].length;
  }
  return out + esc(text.slice(last));
}

/** Same block grammar as the on-screen view, rendered to HTML for the print/PDF and Word exports. */
export function sectionHtml(text: string): string {
  return toBlocks(text)
    .map((b) => {
      if (b.kind === 'h') return `<h3>${inlineHtml(b.lines[0])}</h3>`;
      if (b.kind === 'table') {
        const t = tableRows(b.lines);
        const head = t.head ? `<thead><tr>${t.head.map((c) => `<th>${inlineHtml(c)}</th>`).join('')}</tr></thead>` : '';
        return `<table>${head}<tbody>${t.body.map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      }
      if (b.kind === 'ul' || b.kind === 'ol') return `<${b.kind}>${b.lines.map((l) => `<li>${inlineHtml(l)}</li>`).join('')}</${b.kind}>`;
      return `<p>${inlineHtml(b.lines.join(' '))}</p>`;
    })
    .join('');
}

const EXPORT_CSS = `
@page { size: A4; margin: 20mm 18mm 22mm; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; line-height: 1.5; color: #111; max-width: 760px; margin: 32px auto; padding: 0 16px; }
.classification { text-align: center; font-weight: bold; letter-spacing: .04em; color: #8a1c1c; border: 1px solid #8a1c1c; padding: 4px; margin: 0 0 24px; font-size: 10pt; }
h1 { font-size: 18pt; margin: 0 0 4px; }
.meta { color: #555; font-size: 9.5pt; margin: 0 0 20px; }
h2 { font-size: 13pt; border-bottom: 1px solid #bbb; padding-bottom: 3px; margin: 22px 0 6px; break-after: avoid; page-break-after: avoid; }
h3 { font-size: 11pt; margin: 12px 0 4px; break-after: avoid; }
.status { display: inline-block; font-size: 8.5pt; color: #555; border: 1px solid #bbb; border-radius: 3px; padding: 0 5px; margin-bottom: 6px; }
p { margin: 0 0 8px; }
ul, ol { margin: 0 0 8px 20px; padding: 0; }
li { margin: 0 0 3px; }
li, p { orphans: 3; widows: 3; }
table { border-collapse: collapse; width: 100%; margin: 4px 0 10px; font-size: 9.5pt; break-inside: avoid; }
th, td { border: 1px solid #bbb; padding: 4px 6px; text-align: left; vertical-align: top; }
th { background: #f0f0f0; font-weight: bold; }
.cite { font-size: 8pt; color: #555; white-space: nowrap; }
.footer { margin-top: 28px; border-top: 1px solid #bbb; padding-top: 6px; font-size: 8.5pt; color: #555; }
@media print { body { margin: 0; max-width: none; padding: 0; } .classification { margin-bottom: 16px; } }
`;

/** Older drafts may carry a title block as extra "sections"; show only the template sections when they are present. */
function templateOnly(sections: Section[], template?: string[]): Section[] {
  if (!template?.length) return sections;
  const keep = sections.filter((s) => template.includes(s.title));
  return keep.length >= Math.ceil(template.length / 2) ? keep : sections;
}

export function BriefTab({ caseId, caseNumber, caseTitle }: { caseId: string; caseNumber?: string; caseTitle?: string }) {
  const { me } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const { data, error, loading, reload } = useApi<{ versions: Row[]; sections_template?: string[]; current_pps?: Row | null }>(`/api/cases/${caseId}/brief`);
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
      setSections(templateOnly(v.sections as Section[], data?.sections_template));
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
    const ref = caseNumber || caseId;
    const ver = txt(version?.version ?? 'draft');
    const body = sections.map((s) => `<h2>${esc(s.title)}</h2><span class="status">${esc(s.status)}</span>${sectionHtml(s.body)}`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(ref)} prosecution recommendation v${ver}</title><style>${EXPORT_CSS}</style></head><body>
<div class="classification">OFFICIAL: Sensitive</div>
<h1>Prosecution recommendation — ${esc(ref)}</h1>
${caseTitle ? `<p class="meta"><strong>${esc(caseTitle)}</strong></p>` : ''}
<p class="meta">Brief version ${ver} · exported ${esc(new Date().toLocaleString('en-AU'))} by ${esc(me?.displayName ?? '')}. Sections marked “Draft (AI)” were drafted by AI and have not been reviewed. Citations in [brackets] refer to evidence (EV), timeline events (EVT), agency source records (SR), the Prosecution Priority Score (PPS), scenarios (SCN) and past matters (HM) in the case file.</p>
${body}
<div class="footer">The Prosecution Priority Score is a decision aid; the decision rests with the delegate. OFFICIAL: Sensitive</div>
</body></html>`;
    if (format === 'html') {
      // Open a print-ready page and the print dialog (Save as PDF); fall back to a download if pop-ups are blocked
      const w = window.open('', '_blank');
      if (w) {
        w.document.open();
        w.document.write(html);
        w.document.close();
        w.focus();
        setTimeout(() => w.print(), 300);
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        a.download = `${ref}-brief-v${ver}.html`;
        a.click();
        toast('Pop-up blocked — downloaded the printable brief instead');
      }
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['\ufeff', html], { type: 'application/msword' }));
      a.download = `${ref}-brief-v${ver}.doc`;
      a.click();
    }
    await api.post(`/api/cases/${caseId}/brief/export`, { version: version?.version, format }).catch(() => undefined);
  };

  if (error) return <ErrorState message={error} onRetry={reload} />;
  const canReview = me?.persona !== 'Investigator';
  const stale = Boolean(version?.created_at && data?.current_pps?.scored_at && new Date(txt(data.current_pps.scored_at)) > new Date(txt(version.created_at)));
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
              {stale && (
                <p className="note trend-up" role="status" style={{ marginBottom: 12 }}>
                  Scores have changed since this draft (PPS now {txt(data?.current_pps?.total)} · {txt(data?.current_pps?.band)}, re-scored {dateTime(data?.current_pps?.scored_at)}). Regenerate or update the PPS section before review.
                </p>
              )}
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
                <button key={txt(v.version)} className="list-item link" style={{ textDecoration: 'none', width: '100%', textAlign: 'left' }} onClick={() => { setVersion(v); setSections(templateOnly(v.sections as Section[], data?.sections_template)); setDirty(false); }}>
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
