'use client';

// Read-only presentation of a meeting summary.
//
// The same data the block editor renders, laid out for reading rather
// than editing. Structure comes from the summary JSON, not from the
// model -- asking the model for HTML would break inline editing,
// markdown export, auto-naming and search indexing, all of which walk
// section.blocks[].content.
//
// Type carries the structure. IBM Plex Mono is already this app's
// instrument voice (wordmark, transcript timestamps, REC pill), so it
// marks the DATA roles here -- section labels, owners, dates -- while
// Inter carries prose. Visual weight decays down the page in order of
// urgency: the verdict, then who owes what, then context.
//
// Everything degrades: summaries generated before the structured
// formats existed render as plain bullets rather than breaking.

import type { Summary, Section } from '@/types';

interface Props {
  summary: Summary;
  meetingTitle?: string;
  meetingDate?: string;
}

// Display order. Anything not listed renders afterwards in its own
// order, so an older summary's sections still appear.
const ORDER = [
  'BottomLine',
  'ImmediateActionItems',
  'SectionSummary',
  'KeyItemsDecisions',
  'OpenQuestions',
  'ProblemsSolutions',
  'CriticalDeadlines',
  'NextSteps',
  'Participants',
  'MeetingTone',
  'OtherImportantPoints',
  'ClosingRemarks',
];

const blocksOf = (s?: Section): string[] =>
  (s?.blocks ?? [])
    .map((b) => (b?.content ?? '').trim())
    .filter(Boolean);

/** Split "Owner | action | due" into parts; null when unformatted. */
function parseAction(text: string): { owner: string; action: string; due: string } | null {
  const parts = text.split('|').map((p) => p.trim());
  if (parts.length < 2) return null;
  return {
    owner: parts[0] || 'Unassigned',
    action: parts[1] || '',
    due: parts[2] || 'TBD',
  };
}

/** Split "PROBLEM: x -> PROPOSED: y"; null when unformatted. */
function parseProblem(text: string): { problem: string; proposed: string } | null {
  // [\s\S] rather than the dotAll flag: the build targets pre-ES2018.
  const m = text.match(/^\s*PROBLEM:\s*([\s\S]+?)\s*(?:->|→)\s*PROPOSED:\s*([\s\S]+)$/i);
  if (!m) return null;
  return { problem: m[1].trim(), proposed: m[2].trim() };
}

/** Split "Name -- role"; null when unformatted. */
function parsePerson(text: string): { name: string; role: string } | null {
  const m = text.match(/^\s*(.+?)\s+(?:--|—|-)\s+(.+)$/);
  if (!m) return null;
  return { name: m[1].trim(), role: m[2].trim() };
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-mono text-[10px] uppercase tracking-[1.2px] text-rw-text-tertiary mb-2.5">
      {children}
    </h3>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((t, i) => (
        <li key={i} className="flex gap-2.5 text-[13.5px] leading-[1.6] text-rw-text-primary">
          <span
            className="mt-[7px] h-1 w-1 rounded-full bg-rw-border-strong flex-shrink-0"
            aria-hidden
          />
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

export function SummaryReport({ summary, meetingTitle, meetingDate }: Props) {
  const seen = new Set<string>();
  const ordered: Array<[string, Section]> = [];
  for (const key of ORDER) {
    const sec = summary[key];
    if (sec && blocksOf(sec).length) {
      ordered.push([key, sec]);
      seen.add(key);
    }
  }
  for (const [key, sec] of Object.entries(summary)) {
    if (!seen.has(key) && sec && blocksOf(sec).length) ordered.push([key, sec]);
  }

  if (ordered.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-[13px] text-rw-text-tertiary">Nothing to show yet.</p>
        <p className="text-[12px] text-rw-text-tertiary mt-1">
          Generate a summary to see the report.
        </p>
      </div>
    );
  }

  const bottomLine = blocksOf(summary['BottomLine']);

  return (
    <article className="max-w-[760px]">
      {(meetingTitle || meetingDate) && (
        <header className="mb-7 pb-5 border-b border-rw-border">
          {meetingTitle && (
            <h2 className="text-[19px] font-medium text-rw-text-primary leading-tight">
              {meetingTitle}
            </h2>
          )}
          {meetingDate && (
            <p className="font-mono text-[11px] text-rw-text-tertiary mt-1.5">
              {meetingDate}
            </p>
          )}
        </header>
      )}

      {/* Signature element: the verdict. The one place colour is spent. */}
      {bottomLine.length > 0 && (
        <section className="mb-8 border-l-2 border-rw-primary bg-rw-primary-bg/40 pl-4 pr-4 py-3.5 rounded-r-rw-md">
          <h3 className="font-mono text-[10px] uppercase tracking-[1.2px] text-rw-success-text mb-1.5">
            Bottom line
          </h3>
          {bottomLine.map((t, i) => (
            <p
              key={i}
              className="text-[15px] leading-[1.55] text-rw-text-primary font-medium"
            >
              {t}
            </p>
          ))}
        </section>
      )}

      <div className="space-y-7">
        {ordered.map(([key, section]) => {
          if (key === 'BottomLine') return null;
          const items = blocksOf(section);

          // --- Action items: owner and date are data, so they're mono.
          if (key === 'ImmediateActionItems') {
            const rows = items.map((t) => ({ raw: t, parsed: parseAction(t) }));
            const structured = rows.filter((r) => r.parsed);
            return (
              <section key={key}>
                <Eyebrow>{section.title}</Eyebrow>
                {structured.length === 0 ? (
                  <Bullets items={items} />
                ) : (
                  <div className="overflow-x-auto -mx-1">
                    <table className="w-full border-collapse text-left mx-1">
                      <thead>
                        <tr className="border-b border-rw-border">
                          {['Owner', 'Action', 'Due'].map((h) => (
                            <th
                              key={h}
                              className="font-mono text-[10px] uppercase tracking-[0.8px] text-rw-text-tertiary font-medium pb-2 pr-4 last:pr-0"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => {
                          const p = r.parsed;
                          if (!p) {
                            return (
                              <tr key={i} className="border-b border-rw-border last:border-0">
                                <td colSpan={3} className="py-2.5 text-[13.5px] text-rw-text-primary">
                                  {r.raw}
                                </td>
                              </tr>
                            );
                          }
                          const unowned = /^unassigned$/i.test(p.owner);
                          const undated = /^(tbd|n\/a|unknown)$/i.test(p.due);
                          return (
                            <tr key={i} className="border-b border-rw-border last:border-0 align-top">
                              <td className="py-2.5 pr-4 whitespace-nowrap">
                                <span
                                  className={`font-mono text-[12px] ${
                                    unowned
                                      ? 'text-rw-text-tertiary italic'
                                      : 'text-rw-text-primary'
                                  }`}
                                >
                                  {p.owner}
                                </span>
                              </td>
                              <td className="py-2.5 pr-4 text-[13.5px] leading-[1.55] text-rw-text-primary">
                                {p.action}
                              </td>
                              <td className="py-2.5 whitespace-nowrap">
                                <span
                                  className={`font-mono text-[11.5px] ${
                                    undated
                                      ? 'text-rw-text-tertiary'
                                      : 'text-rw-warning-text'
                                  }`}
                                >
                                  {p.due}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          }

          // --- Problems: the arrow in the data becomes the visual pivot.
          if (key === 'ProblemsSolutions') {
            const pairs = items.map((t) => ({ raw: t, parsed: parseProblem(t) }));
            return (
              <section key={key}>
                <Eyebrow>{section.title}</Eyebrow>
                <div className="space-y-3">
                  {pairs.map((p, i) =>
                    p.parsed ? (
                      <div
                        key={i}
                        className="border border-rw-border rounded-rw-md overflow-hidden"
                      >
                        <div className="px-3 py-2 bg-rw-subtle text-[13.5px] leading-[1.55] text-rw-text-primary">
                          {p.parsed.problem}
                        </div>
                        <div className="px-3 py-2 flex gap-2.5 border-t border-rw-border">
                          <span
                            className="font-mono text-[11px] text-rw-success-text mt-[3px] flex-shrink-0"
                            aria-hidden
                          >
                            &rarr;
                          </span>
                          <span className="text-[13.5px] leading-[1.55] text-rw-text-secondary">
                            {p.parsed.proposed}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <p
                        key={i}
                        className="text-[13.5px] leading-[1.6] text-rw-text-primary"
                      >
                        {p.raw}
                      </p>
                    ),
                  )}
                </div>
              </section>
            );
          }

          // --- Participants: name is an identifier, role is prose.
          if (key === 'Participants') {
            return (
              <section key={key}>
                <Eyebrow>{section.title}</Eyebrow>
                <dl className="space-y-2">
                  {items.map((t, i) => {
                    const p = parsePerson(t);
                    return (
                      <div key={i} className="flex flex-col sm:flex-row sm:gap-3">
                        <dt className="font-mono text-[12px] text-rw-text-primary sm:w-[150px] sm:flex-shrink-0 sm:text-right">
                          {p ? p.name : t}
                        </dt>
                        {p && (
                          <dd className="text-[13px] leading-[1.55] text-rw-text-secondary sm:border-l sm:border-rw-border sm:pl-3">
                            {p.role}
                          </dd>
                        )}
                      </div>
                    );
                  })}
                </dl>
              </section>
            );
          }

          // --- Deadlines: the only other place colour is earned.
          if (key === 'CriticalDeadlines') {
            return (
              <section key={key}>
                <Eyebrow>{section.title}</Eyebrow>
                <ul className="space-y-1.5">
                  {items.map((t, i) => (
                    <li
                      key={i}
                      className="flex gap-2.5 text-[13.5px] leading-[1.6] text-rw-text-primary"
                    >
                      <span
                        className="mt-[6px] h-1.5 w-1.5 rounded-[1px] bg-rw-warning-text flex-shrink-0"
                        aria-hidden
                      />
                      <span>{t}</span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          }

          // --- Tone reads as an observation, not a list.
          if (key === 'MeetingTone') {
            return (
              <section key={key}>
                <Eyebrow>{section.title}</Eyebrow>
                {items.map((t, i) => (
                  <p
                    key={i}
                    className="text-[13.5px] leading-[1.65] text-rw-text-secondary italic"
                  >
                    {t}
                  </p>
                ))}
              </section>
            );
          }

          return (
            <section key={key}>
              <Eyebrow>{section.title}</Eyebrow>
              <Bullets items={items} />
            </section>
          );
        })}
      </div>
    </article>
  );
}
