// Turn a meeting summary into a self-contained HTML document.
//
// Two outputs, one generator:
//   * `summaryHtmlFragment` -- markup for the clipboard, so pasting into
//     Gmail, Notion or Docs keeps the formatting.
//   * `summaryHtmlDocument` -- a standalone .html file that opens in any
//     browser and can be attached to an email.
//
// Every style is inline. A <style> block would be stripped by most mail
// clients, and a Tailwind class would mean nothing outside this app.
//
// Colours, ordering and the text parsers are imported from
// SummaryReport rather than restated, so an exported document can't
// drift from what the user saw on screen. Only the presentation layer
// exists twice, and it has to: React renders to a DOM, this renders to
// a string.
//
// Layout uses tables rather than flexbox. Outlook's rendering engine
// still ignores flex and grid, and a summary that collapses into one
// unreadable column when forwarded is worse than a plainer one that
// survives.

import {
  ACCENT,
  ORDER,
  SECTION_ACCENTS,
  blocksOf,
  initials,
  parseAction,
  parsePerson,
  parseProblem,
  personColor,
  type Accent,
} from './SummaryReport';
import type { Summary, Section } from '@/types';

const SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace";

const INK = '#1F1E1B';
const INK_SOFT = '#5C5A55';
const INK_FAINT = '#94928C';
const LINE = '#E5E2D9';
const PAPER = '#FFFFFF';

/** Escape text for HTML. Meeting content is arbitrary user speech. */
function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function avatar(name: string, size = 26): string {
  const unassigned = /^(unassigned|tbd|n\/a)$/i.test(name);
  const [bg, fg] = unassigned ? ['#EFEDE5', '#94928C'] : personColor(name);
  return (
    `<span style="display:inline-block;width:${size}px;height:${size}px;` +
    `line-height:${size}px;text-align:center;border-radius:${size}px;` +
    `background:${bg};color:${fg};font-family:${MONO};` +
    `font-size:${Math.round(size * 0.4)}px;font-weight:600;">` +
    `${esc(unassigned ? '?' : initials(name))}</span>`
  );
}

function card(accent: Accent, title: string, body: string): string {
  const a = ACCENT[accent];
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ` +
    `style="border-collapse:separate;border:1px solid ${LINE};border-radius:10px;` +
    `background:${PAPER};margin:0 0 14px 0;overflow:hidden;">` +
      `<tr><td style="border-left:3px solid ${a.bar};">` +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">` +
          `<tr><td style="background:${a.head};padding:9px 16px;border-bottom:1px solid ${LINE};">` +
            `<span style="font-family:${MONO};font-size:10.5px;letter-spacing:1.1px;` +
            `text-transform:uppercase;color:${INK};font-weight:600;">${esc(title)}</span>` +
          `</td></tr>` +
          `<tr><td style="padding:13px 16px;">${body}</td></tr>` +
        `</table>` +
      `</td></tr>` +
    `</table>`
  );
}

function bullets(items: string[], accent: Accent): string {
  const a = ACCENT[accent];
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">` +
    items
      .map(
        (t) =>
          `<tr>` +
          `<td width="14" valign="top" style="padding:0 0 8px 0;">` +
          `<span style="display:inline-block;width:6px;height:6px;border-radius:6px;` +
          `background:${a.rule};margin-top:7px;"></span></td>` +
          `<td valign="top" style="padding:0 0 8px 0;font-family:${SANS};font-size:13.5px;` +
          `line-height:1.6;color:${INK};">${esc(t)}</td>` +
          `</tr>`,
      )
      .join('') +
    `</table>`
  );
}

function actionRows(items: string[]): string {
  const rows = items.map((t) => ({ raw: t, parsed: parseAction(t) }));
  if (!rows.some((r) => r.parsed)) return bullets(items, 'teal');

  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">` +
    rows
      .map((r, i) => {
        const last = i === rows.length - 1;
        const edge = last ? '' : `border-bottom:1px solid ${LINE};`;
        if (!r.parsed) {
          return (
            `<tr><td colspan="3" style="padding:9px 0;${edge}font-family:${SANS};` +
            `font-size:13.5px;color:${INK};">${esc(r.raw)}</td></tr>`
          );
        }
        const { owner, action, due } = r.parsed;
        const undated = /^(tbd|n\/a|unknown|ongoing)$/i.test(due);
        const duePill = undated
          ? `background:#F4F2EC;color:${INK_FAINT};`
          : 'background:#F3D492;color:#6A4610;';
        return (
          `<tr>` +
          `<td width="38" valign="top" style="padding:9px 0;${edge}">${avatar(owner)}</td>` +
          `<td valign="top" style="padding:9px 8px 9px 0;${edge}">` +
            `<div style="font-family:${SANS};font-size:13.5px;line-height:1.5;color:${INK};">` +
            `${esc(action)}</div>` +
            `<div style="font-family:${MONO};font-size:10.5px;color:${INK_FAINT};margin-top:2px;">` +
            `${esc(owner)}</div>` +
          `</td>` +
          `<td valign="top" align="right" style="padding:9px 0;${edge}white-space:nowrap;">` +
            `<span style="font-family:${MONO};font-size:10px;padding:4px 8px;` +
            `border-radius:20px;${duePill}">${esc(due)}</span>` +
          `</td>` +
          `</tr>`
        );
      })
      .join('') +
    `</table>`
  );
}

function problemRows(items: string[]): string {
  return items
    .map((t) => {
      const p = parseProblem(t);
      if (!p) {
        return (
          `<p style="margin:0 0 8px 0;font-family:${SANS};font-size:13.5px;` +
          `line-height:1.6;color:${INK};">${esc(t)}</p>`
        );
      }
      return (
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ` +
        `style="border:1px solid ${LINE};border-radius:8px;margin:0 0 9px 0;overflow:hidden;">` +
          `<tr><td style="background:#FDF1EC;padding:8px 11px;font-family:${SANS};` +
          `font-size:13.5px;line-height:1.5;color:${INK};">${esc(p.problem)}</td></tr>` +
          `<tr><td style="padding:8px 11px;border-top:1px solid ${LINE};font-family:${SANS};` +
          `font-size:13.5px;line-height:1.5;color:${INK_SOFT};">` +
          `<span style="color:#12564F;font-family:${MONO};">&rarr;</span> ${esc(p.proposed)}` +
          `</td></tr>` +
        `</table>`
      );
    })
    .join('');
}

function participantRows(items: string[]): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">` +
    items
      .map((t) => {
        const p = parsePerson(t);
        const name = p ? p.name : t;
        return (
          `<tr>` +
          `<td width="42" valign="top" style="padding:0 0 10px 0;">${avatar(name, 30)}</td>` +
          `<td valign="top" style="padding:0 0 10px 0;">` +
            `<div style="font-family:${SANS};font-size:13px;font-weight:600;color:${INK};">` +
            `${esc(name)}</div>` +
            (p
              ? `<div style="font-family:${SANS};font-size:12px;line-height:1.45;` +
                `color:${INK_SOFT};margin-top:2px;">${esc(p.role)}</div>`
              : '') +
          `</td>` +
          `</tr>`
        );
      })
      .join('') +
    `</table>`
  );
}

export interface HtmlOptions {
  title?: string;
  date?: string;
}

/** Markup only -- for the clipboard, or to embed in a fuller document. */
export function summaryHtmlFragment(summary: Summary, opts: HtmlOptions = {}): string {
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

  const counts: string[] = [];
  const n = (k: string) => blocksOf(summary[k]).length;
  if (n('ImmediateActionItems')) counts.push(`${n('ImmediateActionItems')} actions`);
  if (n('KeyItemsDecisions')) counts.push(`${n('KeyItemsDecisions')} decisions`);
  if (n('OpenQuestions')) counts.push(`${n('OpenQuestions')} open`);
  if (n('ProblemsSolutions')) counts.push(`${n('ProblemsSolutions')} problems`);
  if (n('Participants')) counts.push(`${n('Participants')} people`);

  let out = `<div style="max-width:720px;font-family:${SANS};color:${INK};">`;

  if (opts.title || opts.date) {
    out += `<div style="margin:0 0 18px 0;">`;
    if (opts.title) {
      out +=
        `<h1 style="margin:0;font-family:${SANS};font-size:20px;font-weight:600;` +
        `color:${INK};line-height:1.25;">${esc(opts.title)}</h1>`;
    }
    if (opts.date) {
      out +=
        `<div style="font-family:${MONO};font-size:11px;color:${INK_FAINT};margin-top:5px;">` +
        `${esc(opts.date)}</div>`;
    }
    out += `</div>`;
  }

  if (bottomLine.length) {
    out +=
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ` +
      `style="border-collapse:separate;border:1px solid #4FBDB0;border-radius:10px;` +
      `margin:0 0 18px 0;overflow:hidden;background:#DDF3EF;">` +
        `<tr><td style="border-left:5px solid #1A6F66;padding:15px 18px;">` +
          `<div style="font-family:${MONO};font-size:10.5px;letter-spacing:1.3px;` +
          `text-transform:uppercase;color:#12564F;font-weight:700;margin-bottom:7px;">` +
          `Bottom line</div>` +
          bottomLine
            .map(
              (t) =>
                `<p style="margin:0;font-family:${SANS};font-size:16.5px;line-height:1.5;` +
                `font-weight:600;color:#14312D;">${esc(t)}</p>`,
            )
            .join('') +
          (counts.length
            ? `<div style="margin-top:12px;">` +
              counts
                .map(
                  (c) =>
                    `<span style="display:inline-block;font-family:${MONO};font-size:10px;` +
                    `padding:4px 9px;border-radius:20px;background:#FFFFFF;color:#12564F;` +
                    `border:1px solid #A6DCD4;margin:0 5px 5px 0;">${esc(c)}</span>`,
                )
                .join('') +
              `</div>`
            : '') +
        `</td></tr>` +
      `</table>`;
  }

  for (const [key, section] of present) {
    const accent: Accent = SECTION_ACCENTS[key] ?? 'neutral';
    const items = blocksOf(section);
    const title = section.title || key;
    let body: string;
    if (key === 'ImmediateActionItems') body = actionRows(items);
    else if (key === 'ProblemsSolutions') body = problemRows(items);
    else if (key === 'Participants') body = participantRows(items);
    else if (key === 'MeetingTone') {
      body = items
        .map(
          (t) =>
            `<p style="margin:0;font-family:${SANS};font-size:13.5px;line-height:1.65;` +
            `color:${INK_SOFT};font-style:italic;">${esc(t)}</p>`,
        )
        .join('');
    } else body = bullets(items, accent);
    out += card(accent, title, body);
  }

  out += `</div>`;
  return out;
}

/** A complete file, ready to save and open in a browser. */
export function summaryHtmlDocument(summary: Summary, opts: HtmlOptions = {}): string {
  const title = opts.title || 'Meeting summary';
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">\n` +
    `<title>${esc(title)}</title>\n</head>\n` +
    `<body style="margin:0;padding:28px 20px;background:#FAFAF7;">\n` +
    `<div style="margin:0 auto;max-width:720px;">\n` +
    summaryHtmlFragment(summary, opts) +
    `\n<p style="margin:22px 0 0 0;font-family:${MONO};font-size:10px;color:${INK_FAINT};">` +
    `Generated by Neato Rewind</p>\n` +
    `</div>\n</body>\n</html>\n`
  );
}
