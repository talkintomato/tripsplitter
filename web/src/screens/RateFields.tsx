import { CURRENCIES } from '../../../src/core/currencies';
import type { RatePreview } from '../api/rates';
import { balanceText, nameOf } from '../format';
import { useApp } from '../state';

export function CurrencyField(props: { label: string; value: string; onChange(value: string): void; disabled?: boolean; exclude?: string }) {
  return <label className="field"><span>{props.label}</span>
    <select value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value)}>
      {CURRENCIES.filter((c) => c.code !== props.exclude).map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
    </select>
  </label>;
}

export function RateField(props: { home: string; currency: string; value: string; onChange(value: string): void; disabled?: boolean }) {
  return <label className="field"><span>1 {props.home} = how many {props.currency}?</span>
    <input inputMode="decimal" type="text" value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value)} placeholder="Enter rate" />
    <span className="hint small">{props.value ? `1 ${props.home} = ${props.value} ${props.currency}` : 'Use up to 6 decimal places.'}</span>
  </label>;
}

export function RateComparison({ preview, home }: { preview: RatePreview; home: string }) {
  const { group } = useApp();
  const ids = new Set([...group.members.map((m) => m.id), ...Object.keys(preview.balancesBefore).map(Number), ...Object.keys(preview.balancesAfter).map(Number)]);
  return <section className="section" aria-label="Rate preview">
    <p>{preview.expensesChanged} saved {preview.expensesChanged === 1 ? 'expense will' : 'expenses will'} change. {preview.confirmedExpensesChanged} count toward balances.</p>
    <p className="hint small">Expenses with their own rate stay the same. Drafts only count once confirmed.</p>
    <table className="compare"><caption>Balances in {home}</caption>
      <thead><tr><th scope="col">Person</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
      <tbody>{[...ids].map((id) => <tr key={id}><th scope="row">{nameOf(group.members, id)}</th>
        <td>{balanceText(preview.balancesBefore[id] ?? 0, home)}</td><td>{balanceText(preview.balancesAfter[id] ?? 0, home)}</td>
      </tr>)}</tbody>
    </table>
  </section>;
}
