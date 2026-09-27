import { CURRENCIES } from '../../../src/core/currencies';
import type { RatePreview } from '../api/rates';
import { balanceText, nameOf } from '../format';
import type { Member } from '../api/types';

export function CurrencyField(props: { label: string; value: string; onChange(value: string): void; disabled?: boolean; exclude?: string | readonly string[] }) {
  const excluded = props.exclude === undefined ? [] : typeof props.exclude === 'string' ? [props.exclude] : props.exclude;
  return <label className="field"><span>{props.label}</span>
    <select value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value)}>
      {CURRENCIES.filter((c) => !excluded.includes(c.code)).map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
    </select>
  </label>;
}

export function RateField(props: { home: string; currency: string; value: string; onChange(value: string): void; disabled?: boolean }) {
  return <label className="field"><span>1 {props.home} = how many {props.currency}?</span>
    <input inputMode="decimal" type="text" value={props.value} disabled={props.disabled} autoComplete="off" onChange={(e) => props.onChange(e.target.value)} placeholder="Enter rate" />
    <span className="field-hint">{props.value ? `1 ${props.home} = ${props.value} ${props.currency}` : 'Use up to 6 decimal places.'}</span>
  </label>;
}

export function RateComparison({ preview, home, members }: { preview: RatePreview; home: string; members: ReadonlyArray<Member> }) {
  const ids = new Set([...members.map((m) => m.id), ...Object.keys(preview.balancesBefore ?? {}).map(Number), ...Object.keys(preview.balancesAfter ?? {}).map(Number)]);
  return <section className="section rate-preview" aria-label="Rate preview">
    <p>{preview.expensesChanged} saved {preview.expensesChanged === 1 ? 'expense will' : 'expenses will'} change. {preview.confirmedExpensesChanged} {preview.confirmedExpensesChanged === 1 ? 'counts' : 'count'} toward balances.</p>
    <p className="field-hint">Expenses with their own rate stay the same. Drafts only count once confirmed.</p>
    <table className="compare"><caption>Balances in {home}</caption>
      <thead><tr><th scope="col">Person</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
      <tbody>{[...ids].map((id) => <tr key={id}><th scope="row">{nameOf(members, id)}</th>
        <td>{balanceText(preview.balancesBefore?.[id] ?? 0, home)}</td><td>{balanceText(preview.balancesAfter?.[id] ?? 0, home)}</td>
      </tr>)}</tbody>
    </table>
  </section>;
}
