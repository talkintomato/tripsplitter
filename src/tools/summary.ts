import { formatAmount } from '../core/index.js';

export type Line = string | { label: string; value: string } | { label: string; before: string; after: string } | { bullet: string };
export interface Summary { icon: string; title: string; blocks: Array<{ heading?: string; lines: Line[] }> }
export const lineText = (line: Line): string => typeof line === 'string' ? line : 'bullet' in line ? `• ${line.bullet}` : 'value' in line ? `${line.label}: ${line.value}` : `${line.label}: ${line.before} → ${line.after}`;
export const escapeHtml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function toPlainText(summary: Summary): string {
  return [ [summary.icon, summary.title].filter(Boolean).join(' '), ...summary.blocks.map(b => [b.heading, ...b.lines.map(lineText)].filter(v => v !== undefined).join('\n')) ].filter(Boolean).join('\n\n');
}
export function toTelegramHtml(summary: Summary): string {
  return telegramChunks(summary, Number.MAX_SAFE_INTEGER).join('\n\n');
}
/** Pack complete blocks; an oversized block becomes smaller blocks of complete lines.
 * A single oversized line is split as Unicode text before escaping or wrapping tags. */
export function telegramChunks(summary: Summary, limit = 4000): string[] {
  const blocks = [
    ...(summary.title ? [{ heading: [summary.icon, summary.title].filter(Boolean).join(' '), lines: [] as Line[] }] : []),
    ...summary.blocks,
  ];
  const units: string[] = [];
  for (const block of blocks) {
    const lines = [...(block.heading ? [{ text: block.heading, bold: true }] : []), ...block.lines.map(line => ({ text: lineText(line), bold: false }))];
    const rendered = lines.map(l => l.bold ? `<b>${escapeHtml(l.text)}</b>` : escapeHtml(l.text));
    if (rendered.join('\n').length <= limit) { units.push(rendered.join('\n')); continue; }
    let part = '';
    for (const line of lines) {
      const wrap = (v: string) => line.bold ? `<b>${v}</b>` : v;
      let fragment = '';
      const fragments: string[] = [];
      for (const char of line.text) {
        const escaped = escapeHtml(char);
        if (wrap(fragment + escaped).length > limit) { fragments.push(wrap(fragment)); fragment = ''; }
        fragment += escaped;
      }
      fragments.push(wrap(fragment));
      for (const fragment of fragments) {
        if (part && part.length + 1 + fragment.length > limit) { units.push(part); part = ''; }
        part += (part ? '\n' : '') + fragment;
      }
    }
    if (part) units.push(part);
  }
  const chunks: string[] = [];
  for (const unit of units.filter(Boolean)) {
    const last = chunks.length - 1;
    if (last >= 0 && chunks[last]!.length + 2 + unit.length <= limit) chunks[last] += `\n\n${unit}`;
    else chunks.push(unit);
  }
  return chunks;
}
/** Display grouping only; foundation formatAmount owns precision and currency. */
export const displayAmount = (amount: Parameters<typeof formatAmount>[0], currency: string): string =>
  formatAmount(amount, currency).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export function displayDate(date: string, now: Date): string {
  const at = new Date(`${date}T12:00:00+08:00`);
  const options = { timeZone: 'Asia/Singapore' };
  const year = new Intl.DateTimeFormat('en', { ...options, year: 'numeric' });
  return new Intl.DateTimeFormat('en-GB', { ...options, weekday: 'short', day: 'numeric', month: 'short', ...(year.format(at) !== year.format(now) ? { year: 'numeric' as const } : {}) }).format(at).replace(',', '').replace('Sept', 'Sep');
}
export const summaryFields = (structuredSummary: Summary) => ({ structuredSummary, summary: toPlainText(structuredSummary) });
export function combineSummaries(summaries: Summary[]): Summary {
  if (summaries.length === 1) return summaries[0]!;
  return { icon: '', title: `${summaries.length} changes`, blocks: summaries.flatMap(s => [{ heading: `${s.icon} ${s.title}`, lines: [] }, ...s.blocks]) };
}
