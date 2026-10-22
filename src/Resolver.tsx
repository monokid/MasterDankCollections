/** The resolver: answer the questions the distiller could not.
 *
 *  Answers live in browser storage while you work, and are exported as a
 *  rules.json that gets committed and fed back into the distiller. Nothing here
 *  writes to the catalogue directly -- the catalogue is a build artefact, and
 *  keeping the answers as a checked-in file is what makes a run reproducible.
 *
 *  Everything is answerable, not just the open questions: a folder the distiller
 *  was confident about can still have been read wrong, so the full segment list
 *  is editable underneath.
 */
import { useMemo, useState } from "react";
import type { Catalog, SegmentRole } from "./catalog.ts";

const ROLES: SegmentRole[] = ["person", "phase", "wrapper", "album", "ignore"];
const STORAGE_KEY = "mdc-rules-draft";

interface Draft {
  segmentRoles: Record<string, SegmentRole>;
  personAliases: Record<string, string>;
  eventDates: Record<string, string>;
}

const EMPTY: Draft = { segmentRoles: {}, personAliases: {}, eventDates: {} };

function load(): Draft {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    // Private windows and blocked storage both land here; an empty draft is
    // a perfectly good starting point.
  }
  return EMPTY;
}

function save(d: Draft) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); } catch { /* ignore */ }
}

export default function Resolver({ cat }: { cat: Catalog }) {
  const [draft, setDraft] = useState<Draft>(load);
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const update = (fn: (d: Draft) => Draft) => {
    setDraft((prev) => { const next = fn(prev); save(next); return next; });
    setCopied(false);
  };

  const setRole = (key: string, role: SegmentRole) =>
    update((d) => ({ ...d, segmentRoles: { ...d.segmentRoles, [key]: role } }));

  const setAlias = (key: string, name: string) =>
    update((d) => {
      const personAliases = { ...d.personAliases };
      if (name.trim()) personAliases[key] = name.trim();
      else delete personAliases[key];
      return { ...d, personAliases };
    });

  const setDate = (folder: string, iso: string) =>
    update((d) => {
      const eventDates = { ...d.eventDates };
      if (iso) eventDates[folder.toLowerCase()] = iso;
      else delete eventDates[folder.toLowerCase()];
      return { ...d, eventDates };
    });

  const answered = Object.keys(draft.segmentRoles).length +
    Object.keys(draft.eventDates).length;

  // Answered questions stay on screen rather than vanishing: a "person" answer
  // opens a follow-up alias field, which would be unreachable if the card
  // disappeared the moment it was answered.
  const isAnswered = (q: typeof cat.questions[number]) =>
    q.kind === "segment-role"
      ? !!draft.segmentRoles[q.subject]
      : !!draft.eventDates[q.subject.toLowerCase()];
  const openCount = cat.questions.filter((q) => !isAnswered(q)).length;
  const questions = [...cat.questions].sort(
    (a, b) => Number(isAnswered(a)) - Number(isAnswered(b)));

  const rulesJson = useMemo(() => JSON.stringify({
    you: cat.people.find((p) => p.isYou)?.name ?? "",
    segmentRoles: draft.segmentRoles,
    personAliases: draft.personAliases,
    notPeople: [],
    eventDates: draft.eventDates,
  }, null, 2), [draft]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(rulesJson);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="page">
      <h1>Resolve</h1>
      <p className="sub">
        The catalogue already works — {Math.round(cat.stats.personCoverage * 100)}% of
        tracks are attributed without any of these answered. Answering them raises that;
        it is not a precondition for anything.
      </p>

      {openCount === 0 && questions.length === 0 ? (
        <div className="panel q">
          <div className="subject">Nothing left to answer</div>
          <div className="why">
            Every open question has a draft answer. Export below, drop the file in
            <code> tools/rules.json</code>, and re-run <code>npm run distill</code>.
          </div>
        </div>
      ) : (
        questions.map((q) => {
          const done = isAnswered(q);
          if (q.kind === "event-date") {
            return (
              <div className={`panel q ${done ? "done" : ""}`} key={q.id}>
                <div className="subject">{q.subject}{done ? " ✓" : ""}</div>
                <div className="why">
                  This folder has {q.occurrences} tracks but no date in its name, so it
                  sorts as undated. What date was it?
                </div>
                <div className="aliasrow">
                  <input type="date"
                    value={draft.eventDates[q.subject.toLowerCase()] ?? ""}
                    onChange={(e) => setDate(q.subject, e.target.value)} />
                  <span className="hint">leave blank to keep it undated</span>
                </div>
              </div>
            );
          }
          const seg = cat.segments.find((s) => s.key === q.subject);
          return (
            <div className={`panel q ${done ? "done" : ""}`} key={q.id}>
              <div className="subject">{seg?.name ?? q.subject}{done ? " ✓" : ""}</div>
              <div className="why">
                Appears {q.occurrences} times across {q.events.length} event
                {q.events.length === 1 ? "" : "s"}, and matches nothing the distiller
                recognises. What kind of folder is it?
              </div>
              <div className="examples">
                {q.examples.map((e, i) => <div key={i}>{e}</div>)}
              </div>
              <div className="opts">
                {ROLES.map((r) => (
                  <button key={r} className="opt"
                    aria-pressed={draft.segmentRoles[q.subject] === r}
                    onClick={() => setRole(q.subject, r)}>
                    {r}
                  </button>
                ))}
              </div>
              {draft.segmentRoles[q.subject] === "person" && (
                <div className="aliasrow">
                  <input
                    placeholder="Canonical name"
                    value={draft.personAliases[q.subject] ?? ""}
                    onChange={(e) => setAlias(q.subject, e.target.value)} />
                  <span className="hint">
                    fold this spelling into an existing person — leave blank to keep
                    “{seg?.name ?? q.subject}” as its own
                  </span>
                </div>
              )}
            </div>
          );
        })
      )}

      <h2 style={{ marginTop: 32 }}>
        Every folder the distiller classified
        <button className="btn ghost" style={{ marginLeft: 14, padding: "5px 13px", fontSize: 12.5 }}
          onClick={() => setShowAll((s) => !s)}>
          {showAll ? "hide" : `show all ${cat.segments.length}`}
        </button>
      </h2>
      <p className="sub">
        A confident guess can still be wrong. Override anything here.
      </p>

      {showAll && (
        <div className="panel" style={{ padding: "6px 14px 12px", overflowX: "auto" }}>
          <table className="segtable">
            <thead>
              <tr>
                <th>Folder</th><th>Role</th><th>Decided by</th>
                <th>Uses</th><th>Override</th>
              </tr>
            </thead>
            <tbody>
              {cat.segments.map((s) => {
                const override = draft.segmentRoles[s.key];
                return (
                  <tr key={s.key}>
                    <td>{s.name}</td>
                    <td className="role">{override ?? s.role}</td>
                    <td className={`src ${override ? "rule" : s.source}`}>
                      {override ? "you" : s.source}
                    </td>
                    <td>{s.occurrences}</td>
                    <td>
                      <select value={override ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (!v) {
                            update((d) => {
                              const segmentRoles = { ...d.segmentRoles };
                              delete segmentRoles[s.key];
                              return { ...d, segmentRoles };
                            });
                          } else setRole(s.key, v as SegmentRole);
                        }}>
                        <option value="">(keep {s.role})</option>
                        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="exportbar">
        <strong>{answered} answer{answered === 1 ? "" : "s"}</strong>
        <span className="src">
          {openCount} question{openCount === 1 ? "" : "s"} still open
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn ghost" onClick={() => update(() => EMPTY)}>Reset</button>
        <button className="btn" onClick={copy}>
          {copied ? "Copied ✓" : "Copy rules.json"}
        </button>
      </div>

      {answered > 0 && <pre className="rules">{rulesJson}</pre>}
    </div>
  );
}
