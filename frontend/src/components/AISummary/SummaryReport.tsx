'use client';

// Read-only presentation of a meeting summary.
//
// Same data the block editor renders, laid out for reading. Structure
// comes from the summary JSON, not from the model -- asking the model
// for HTML would break inline editing, both markdown exporters,
// auto-naming and search indexing, all of which walk
// section.blocks[].content.
//
// Design notes
// ------------
// A meeting is people and what they committed to. The transcript view
// already renders speakers as colour-coded initial circles, so those
// avatars carry through here onto action-item owners and participants.
// It ties the summary back to the recording it came from rather than
// looking like a generic report template.
//
// Colour is semantic, never decorative: teal for outcomes, amber for
// time pressure, coral for problems, violet for open questions. A
// reader learns the code once and can then scan by hue.
//
// IBM Plex Mono is this app's instrument voice already (wordmark,
// transcript timestamps, REC pill), so it marks extracted data --
// section labels, owner names, dates, counts -- while Inter carries
// prose.
//
// Everything degrades: summaries generated before these formats
// existed render as plain bullets rather than breaking.

import {
  Sparkles, ListChecks, MessageSquareText, CheckCircle2, HelpCircle,
  AlertTriangle, CalendarClock, ArrowRight, Users, Activity, Info, Flag,
} from 'lucide-react';
import type { Summary, Section } from '@/types';

interface Props {
  summary: Summary;
  meetingTitle?: string;
  meetingDate?: string;
}

type Accent = 'teal' | 'amber' | 'coral' | 'violet' | 'neutral';

interface SectionStyle {
  title?: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: Accent;
}

// Display order, icon, and semantic accent per section.
const SECTIONS: Record<string, SectionStyle> = {
  ImmediateActionItems: { icon: ListChecks, accent: 'teal' },
  SectionSummary: { icon: MessageSquareText, accent: 'neutral' },
  KeyItemsDecisions: { icon: CheckCircle2, accent: 'teal' },
  OpenQuestions: { icon: HelpCircle, accent: 'violet' },
  ProblemsSolutions: { icon: AlertTriangle, accent: 'coral' },
  CriticalDeadlines: { icon: CalendarClock, accent: 'amber' },
  NextSteps: { icon: ArrowRight, accent: 'neutral' },
  Participants: { icon: Users, accent: 'neutral' },
  MeetingTone: { icon: Activity, accent: 'neutral' },
  OtherImportantPoints: { icon: Info, accent: 'neutral' },
  ClosingRemarks: { icon: Flag, accent: 'neutral' },
};

const ORDER = [
  'ImmediateActionItems', 'SectionSummary', 'KeyItemsDecisions',
  'OpenQuestions', 'ProblemsSolutions', 'CriticalDeadlines',
  'NextSteps', 'Participants', 'MeetingTone', 'OtherImportantPoints',
  'ClosingRemarks',
];

// Saturated enough to read as colour at a glance rather than as tinted
// grey. `bar` runs down the card's left edge so the section's meaning
// is legible before any text is.
const ACCENT: Record<
  Accent,
  { chip: string; icon: string; rule: string; bar: string; head: string }
> = {
  teal:    { chip: 'bg-[#9FDCD2]', icon: 'text-[#12564F]', rule: 'bg-[#4FBDB0]', bar: 'bg-[#2EA89F]', head: 'bg-[#EFFAF8]' },
  amber:   { chip: 'bg-[#F3D492]', icon: 'text-[#6A4610]', rule: 'bg-[#D9A83F]', bar: 'bg-[#C9902B]', head: 'bg-[#FDF6E7]' },
  coral:   { chip: 'bg-[#F4B69B]', icon: 'text-[#8C2F12]', rule: 'bg-[#E2825C]', bar: 'bg-[#DB6B41]', head: 'bg-[#FDF1EC]' },
  violet:  { chip: 'bg-[#C7B8E6]', icon: 'text-[#463368]', rule: 'bg-[#9C86CE]', bar: 'bg-[#7E64BC]', head: 'bg-[#F5F2FC]' },
  neutral: { chip: 'bg-[#DAD6C9]', icon: 'text-[#4A4843]', rule: 'bg-[#B8B3A3]', bar: 'bg-[#A8A294]', head: 'bg-[#F7F5EF]' },
};

// Person colours. Deeper than the transcript's mostly grayscale ramp:
// here the avatar is doing identification work at small size, so it
// has to hold its colour rather than recede.
const PERSON_COLORS: Array<[string, string]> = [
  ['#8FD5CA', '#0F4F48'],
  ['#BBA8E0', '#3E2C63'],
  ['#F0CE84', '#63410C'],
  ['#AFCFA3', '#2F4B29'],
  ['#A8C4DE', '#28455E'],
  ['#F2AE8E', '#7E2A0F'],
];

function personColor(name: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffff;
  return PERSON_COLORS[hash % PERSON_COLORS.length];
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  // One letter for a single name. Two letters ("RO", "MI") reads like a
  // ticker symbol rather than a person.
  if (words.length === 1) return words[0][0].toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

const blocksOf = (s?: Section): string[] =>
  (s?.blocks ?? []).map((b) => (b?.content ?? '').trim()).filter(Boolean);

function parseAction(text: string) {
  const parts = text.split('|').map((p) => p.trim());
  if (parts.length < 2) return null;
  return { owner: parts[0] || 'Unassigned', action: parts[1] || '', due: parts[2] || 'TBD' };
}

function parseProblem(text: string) {
  // [\s\S] rather than the dotAll flag: the build targets pre-ES2018.
  const m = text.match(/^\s*PROBLEM:\s*([\s\S]+?)\s*(?:->|→)\s*PROPOSED:\s*([\s\S]+)$/i);
  return m ? { problem: m[1].trim(), proposed: m[2].trim() } : null;
}

function parsePerson(text: string) {
  const m = text.match(/^\s*(.+?)\s+(?:--|—|-)\s+(.+)$/);
  return m ? { name: m[1].trim(), role: m[2].trim() } : null;
}

function Avatar({ name, size = 26 }: { name: string; size?: number }) {
  const unassigned = /^(unassigned|tbd|n\/a)$/i.test(name);
  const [bg, fg] = unassigned ? ['#EFEDE5', '#94928C'] : personColor(name);
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-mono font-medium flex-shrink-0"
      style={{
        background: bg,
        color: fg,
        width: size,
        height: size,
        fontSize: size * 0.4,
      }}
      aria-hidden
    >
      {unassigned ? '?' : initials(name)}
    </span>
  );
}

function SectionCard({
  style, title, children,
}: {
  style: SectionStyle;
  title: string;
  children: React.ReactNode;
}) {
  const a = ACCENT[style.accent];
  const Icon = style.icon;
  return (
    <section className="relative rounded-rw-lg border border-rw-border bg-rw-card overflow-hidden shadow-[0_1px_2px_rgba(31,30,27,0.04)]">
      {/* The hue reads before the words do. */}
      <span className={`absolute inset-y-0 left-0 w-[3px] ${a.bar}`} aria-hidden />
      <div className={`flex items-center gap-2.5 pl-5 pr-4 py-2.5 border-b border-rw-border ${a.head}`}>
        <span className={`inline-flex items-center justify-center w-6 h-6 rounded-md ${a.chip}`}>
          <Icon className={`w-3.5 h-3.5 ${a.icon}`} />
        </span>
        <h3 className="font-mono text-[10.5px] uppercase tracking-[1.1px] text-rw-text-primary font-medium">
          {title}
        </h3>
      </div>
      <div className="pl-5 pr-4 py-3.5">{children}</div>
    </section>
  );
}

function Bullets({ items, accent }: { items: string[]; accent: Accent }) {
  const a = ACCENT[accent];
  return (
    <ul className="space-y-2">
      {items.map((t, i) => (
        <li key={i} className="flex gap-2.5 text-[13.5px] leading-[1.6] text-rw-text-primary">
          <span className={`mt-[7px] h-1.5 w-1.5 rounded-full ${a.rule} flex-shrink-0`} aria-hidden />
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

export function SummaryReport({ summary, meetingTitle, meetingDate }: Props) {
  const bottomLine = blocksOf(summary['BottomLine']);

  const present: Array<[string, Section]> = [];
  const seen = new Set<string>(['BottomLine']);
  for (const key of ORDER) {
    const sec = summary[key];
    if (sec && blocksOf(sec).length) { present.push([key, sec]); seen.add(key); }
  }
  for (const [key, sec] of Object.entries(summary)) {
    if (!seen.has(key) && sec && blocksOf(sec).length) present.push([key, sec]);
  }

  if (present.length === 0 && bottomLine.length === 0) {
    return (
      <div className="py-14 text-center">
        <p className="text-[13px] text-rw-text-tertiary">Nothing to show yet.</p>
        <p className="text-[12px] text-rw-text-tertiary mt-1">
          Generate a summary to see the report.
        </p>
      </div>
    );
  }

  // A one-line read of the meeting's shape. Real counts, set quietly in
  // mono -- informative without turning into a dashboard.
  const counts: string[] = [];
  const n = (k: string) => blocksOf(summary[k]).length;
  if (n('ImmediateActionItems')) counts.push(`${n('ImmediateActionItems')} actions`);
  if (n('KeyItemsDecisions')) counts.push(`${n('KeyItemsDecisions')} decisions`);
  if (n('OpenQuestions')) counts.push(`${n('OpenQuestions')} open`);
  if (n('ProblemsSolutions')) counts.push(`${n('ProblemsSolutions')} problems`);
  if (n('Participants')) counts.push(`${n('Participants')} people`);

  return (
    <article className="max-w-[780px] pb-4">
      {(meetingTitle || meetingDate) && (
        <header className="mb-5">
          {meetingTitle && (
            <h2 className="text-[20px] font-medium text-rw-text-primary leading-tight tracking-[-0.01em]">
              {meetingTitle}
            </h2>
          )}
          {meetingDate && (
            <p className="font-mono text-[11px] text-rw-text-tertiary mt-1.5">{meetingDate}</p>
          )}
        </header>
      )}

      {/* The verdict. The one place the page raises its voice. */}
      {bottomLine.length > 0 ? (
        <section
          className="relative mb-6 rounded-rw-lg overflow-hidden border border-[#4FBDB0]/60 shadow-[0_2px_10px_rgba(46,168,159,0.13)]"
          style={{ background: 'linear-gradient(135deg,#C6EAE3 0%,#DDF3EF 42%,#F7E9C9 100%)' }}
        >
          <span className="absolute inset-y-0 left-0 w-[5px] bg-[#1A6F66]" aria-hidden />
          <div className="pl-6 pr-5 py-4">
            <div className="flex items-center gap-1.5 mb-2">
              <Sparkles className="w-3.5 h-3.5 text-[#12564F]" aria-hidden />
              <h3 className="font-mono text-[10.5px] uppercase tracking-[1.3px] text-[#12564F] font-semibold">
                Bottom line
              </h3>
            </div>
            {bottomLine.map((t, i) => (
              <p
                key={i}
                className="text-[16.5px] leading-[1.5] text-[#14312D] font-medium tracking-[-0.005em]"
              >
                {t}
              </p>
            ))}
            {counts.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3.5">
                {counts.map((c) => (
                  <span
                    key={c}
                    className="font-mono text-[10px] px-2 py-1 rounded-full bg-white/70 text-[#12564F] border border-[#4FBDB0]/40"
                  >
                    {c}
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>
      ) : (
        // Summaries predating the current prompt have no bottom line.
        // Say so, rather than leaving an unexplained gap where the most
        // important thing should be.
        <section className="mb-6 rounded-rw-lg border border-dashed border-rw-border-strong bg-rw-subtle px-5 py-3.5">
          <h3 className="font-mono text-[10.5px] uppercase tracking-[1.3px] text-rw-text-tertiary mb-1">
            Bottom line
          </h3>
          <p className="text-[13px] text-rw-text-secondary leading-[1.55]">
            This summary was written before bottom lines were added. Regenerate it to
            get one, along with participants, open questions and owner-assigned actions.
          </p>
        </section>
      )}

      <div className="space-y-4">
        {present.map(([key, section]) => {
          const style = SECTIONS[key] ?? { icon: Info, accent: 'neutral' as Accent };
          const items = blocksOf(section);
          const title = section.title || key;

          // --- Action items: owners get faces, gaps stay visible.
          if (key === 'ImmediateActionItems') {
            const rows = items.map((t) => ({ raw: t, parsed: parseAction(t) }));
            const anyStructured = rows.some((r) => r.parsed);
            return (
              <SectionCard key={key} style={style} title={title}>
                {!anyStructured ? (
                  <Bullets items={items} accent={style.accent} />
                ) : (
                  <div className="-my-1">
                    {rows.map((r, i) => {
                      const p = r.parsed;
                      if (!p) {
                        return (
                          <div
                            key={i}
                            className="py-2.5 text-[13.5px] text-rw-text-primary border-b border-rw-border last:border-0"
                          >
                            {r.raw}
                          </div>
                        );
                      }
                      const undated = /^(tbd|n\/a|unknown|ongoing)$/i.test(p.due);
                      return (
                        <div
                          key={i}
                          className="flex items-start gap-3 py-2.5 border-b border-rw-border last:border-0"
                        >
                          <Avatar name={p.owner} />
                          <div className="min-w-0 flex-1">
                            <p className="text-[13.5px] leading-[1.5] text-rw-text-primary">
                              {p.action}
                            </p>
                            <p className="font-mono text-[10.5px] text-rw-text-tertiary mt-0.5">
                              {p.owner}
                            </p>
                          </div>
                          <span
                            className={`font-mono text-[10.5px] px-2 py-1 rounded-full whitespace-nowrap flex-shrink-0 ${
                              undated
                                ? 'bg-rw-subtle text-rw-text-tertiary'
                                : 'bg-[#FAEBC8] text-[#7A5311]'
                            }`}
                          >
                            {p.due}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </SectionCard>
            );
          }

          // --- Problems pivot on the arrow already in the data.
          if (key === 'ProblemsSolutions') {
            return (
              <SectionCard key={key} style={style} title={title}>
                <div className="space-y-2.5">
                  {items.map((t, i) => {
                    const p = parseProblem(t);
                    if (!p) {
                      return (
                        <p key={i} className="text-[13.5px] leading-[1.6] text-rw-text-primary">
                          {t}
                        </p>
                      );
                    }
                    return (
                      <div key={i} className="rounded-rw-md border border-rw-border overflow-hidden">
                        <div className="flex gap-2.5 px-3 py-2 bg-[#FAE0D6]/40">
                          <AlertTriangle
                            className="w-3.5 h-3.5 text-[#A03715] mt-[3px] flex-shrink-0"
                            aria-hidden
                          />
                          <p className="text-[13.5px] leading-[1.5] text-rw-text-primary">
                            {p.problem}
                          </p>
                        </div>
                        <div className="flex gap-2.5 px-3 py-2 border-t border-rw-border">
                          <ArrowRight
                            className="w-3.5 h-3.5 text-[#1A6F66] mt-[3px] flex-shrink-0"
                            aria-hidden
                          />
                          <p className="text-[13.5px] leading-[1.5] text-rw-text-secondary">
                            {p.proposed}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </SectionCard>
            );
          }

          // --- Participants: the people the meeting was made of.
          if (key === 'Participants') {
            return (
              <SectionCard key={key} style={style} title={title}>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {items.map((t, i) => {
                    const p = parsePerson(t);
                    const name = p ? p.name : t;
                    return (
                      <div key={i} className="flex items-start gap-2.5">
                        <Avatar name={name} size={30} />
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium text-rw-text-primary leading-tight">
                            {name}
                          </p>
                          {p && (
                            <p className="text-[12px] text-rw-text-secondary leading-[1.45] mt-0.5">
                              {p.role}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </SectionCard>
            );
          }

          // --- Deadlines read as dated items, so date-first.
          if (key === 'CriticalDeadlines') {
            return (
              <SectionCard key={key} style={style} title={title}>
                <ul className="space-y-2">
                  {items.map((t, i) => (
                    <li key={i} className="flex gap-2.5 items-start">
                      <CalendarClock
                        className="w-3.5 h-3.5 text-[#7A5311] mt-[3px] flex-shrink-0"
                        aria-hidden
                      />
                      <span className="text-[13.5px] leading-[1.55] text-rw-text-primary">{t}</span>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            );
          }

          // --- Tone is an observation, not a list.
          if (key === 'MeetingTone') {
            return (
              <SectionCard key={key} style={style} title={title}>
                {items.map((t, i) => (
                  <p
                    key={i}
                    className="text-[13.5px] leading-[1.65] text-rw-text-secondary italic"
                  >
                    {t}
                  </p>
                ))}
              </SectionCard>
            );
          }

          return (
            <SectionCard key={key} style={style} title={title}>
              <Bullets items={items} accent={style.accent} />
            </SectionCard>
          );
        })}
      </div>
    </article>
  );
}
