import { getExpense, getTrip, listTripRates, previewTripRate, type ExpenseDetail, type ExpenseInput } from '../../db/index.js';
import { resolveRate, isValidRate, formatAmount, validateExpense } from '../../core/index.js';
import { inputOf, makeInput, expenseAmounts, quotedName, openTrip, refuse, splitInput, type ExpensePatch } from './shared.js';
import type { ToolContext, PlannedAction } from '../types.js';

export function ratePlan(c:ToolContext, tripId:number, currency:string, rate:string, origin:'member'|'suggested'): PlannedAction {
  const t=getTrip(c.db,c.scope,tripId);
  const preview=previewTripRate(c.db,c.scope,tripId,currency,rate);
  return {action:{kind:'set_trip_rate',tripId,currency,rate,origin,snapshot:preview.snapshot},confirmLabel:'Set rate',
    summary:`Set trip rate: 1 ${t.homeCurrency} = ${rate} ${currency} (${origin}).\nWarning: changing the trip rate will update ${preview.expensesChanged} expenses (${preview.confirmedExpensesChanged} confirmed).`};
}
export async function prepareExpense(c:ToolContext, tripId:number, args:ExpensePatch, existing?:ExpenseDetail, allowIncomplete = false) {
  const t=getTrip(c.db,c.scope,tripId); openTrip(t);
  const input=makeInput(c,args,existing);
  if(input.currencyNeedsReview && !allowIncomplete) refuse('Which currency is on the receipt? Confirm its currency first.');
  const tripRate=listTripRates(c.db,c.scope,t.id).find(r=>r.currency===input.currency);
  let resolved=resolveRate({expenseCurrency:input.currency!,homeCurrency:t.homeCurrency,expenseOverride:input.rateOverride,tripRate:tripRate?.rate});
  const plans:PlannedAction[]=[];
  let origin:string=tripRate?.origin ?? '';
  if(resolved.source==='missing') {
    let suggested:string|null=null;
    try { suggested=await c.suggestRate(t.homeCurrency,input.currency!); } catch { /* Ask for a rate; never log user data. */ }
    if(!isValidRate(suggested)) refuse(`What is the rate for ${input.currency} per 1 ${t.homeCurrency}? I couldn't look it up.`);
    plans.push(ratePlan(c,t.id,input.currency!,suggested,'suggested'));
    resolved=resolveRate({expenseCurrency:input.currency!,homeCurrency:t.homeCurrency,tripRate:suggested}); origin='suggested';
  }
  const split = splitInput(input);
  const problems = validateExpense(split.expense, split.items, split.shares);
  const rendered = allowIncomplete && (problems.length > 0 || input.currencyNeedsReview)
    ? { summary: `${JSON.stringify(input.description || input.merchant || 'Expense')} · ${formatAmount(input.total, input.currency!)}\nPaid by ${quotedName(c, input.payerId)} · ${input.expenseDate}\nDraft remains unconfirmed; does not count toward balances.\n${input.currencyNeedsReview ? 'Check the receipt currency. ' : ''}${problems.map(p => p.message).join(' ')}`, preview: { problems } }
    : renderExpense(c,input,t,resolved.rate,resolved.source==='trip' ? `trip, ${origin}` : resolved.source);
  return {input,plans,...rendered,rate:resolved};
}
/** Reusable final rendering: all money and conversions come from foundation functions. */
export function renderExpense(c:ToolContext,input:ExpenseInput,t:ReturnType<typeof getTrip>,fxRate:string|null,source:string) {
  const preview=expenseAmounts(c,input,t,fxRate);
  let summary=`${JSON.stringify(input.description || input.merchant || 'Expense')} · ${formatAmount(input.total,input.currency!)}\nPaid by ${quotedName(c,input.payerId)} · ${input.expenseDate} · ${input.splitType} split\n`;
  summary+=Object.entries(preview.amounts).map(([memberId,value])=>`${quotedName(c,Number(memberId))}: ${formatAmount(value,input.currency!)}`).join('; ');
  if(input.currency!==t.homeCurrency) {
    summary+=`\nHome total: ${preview.homeTotal} · 1 ${t.homeCurrency} = ${fxRate} ${input.currency} (${source})\n`;
    summary+=Object.entries(preview.homeAmounts).map(([memberId,value])=>`${quotedName(c,Number(memberId))}: ${formatAmount(value,t.homeCurrency)}`).join('; ');
  }
  if(input.merchant)summary+=`\nMerchant: ${JSON.stringify(input.merchant)}.`;
  if(input.items?.length) summary+=`\nItems: ${input.items.map(i=>`${JSON.stringify(i.label)} × ${i.quantity ?? 1}: ${formatAmount(i.amount,input.currency!)} (line total; ${i.shares?.length?i.shares.map(s=>`${quotedName(c,s.memberId)} weight ${s.weight??1}`).join(', '):'everyone included'})`).join('; ')}`;
  if(input.splitType==='portions')summary+=`\nPortions: ${input.shares.map(s=>`${quotedName(c,s.memberId)}: ${s.weight??1}`).join('; ')}.`;
  if(input.tax || input.tip || input.serviceCharge || input.discount) summary+=`\nTax: ${formatAmount(input.tax??0,input.currency!)} (${input.taxIncluded?'included':'added'}); tip: ${formatAmount(input.tip??0,input.currency!)}; service charge: ${formatAmount(input.serviceCharge??0,input.currency!)}; discount: ${formatAmount(input.discount??0,input.currency!)}.`;
  return {summary,preview};
}

export async function changeExpense(c:ToolContext, kind:'edit_expense'|'approve_draft'|'set_expense_rate', expenseId:number, changes:ExpensePatch) {
  const existing=getExpense(c.db,c.scope,expenseId);
  if(kind==='approve_draft' ? existing.status!=='draft' : !['draft','confirmed'].includes(existing.status)) refuse(kind==='approve_draft'?'Only a receipt draft can be approved.':'Restore the expense before changing it.');
  const prepared=await prepareExpense(c,existing.tripId,changes,existing,existing.status==='draft' && kind!=='approve_draft');
  const label=kind==='approve_draft'?'Approve it':kind==='set_expense_rate'?'Set rate':'Change it';
  const verb=kind==='approve_draft'?'Approve draft':kind==='set_expense_rate'?'Change expense rate':'Edit expense';
  return {kind:'proposal' as const, plans:[...prepared.plans,{action:{kind,expenseId,input:prepared.input},summary:`${verb} #${expenseId}\n${prepared.summary}`,confirmLabel:label}]};
}
export function removalSummary(c:ToolContext, verb:string, e:ExpenseDetail):string {
  const t=getTrip(c.db,c.scope,e.tripId);
  let detail:string;
  try { detail=renderExpense(c,inputOf(e),t,e.fxRate,e.fxRateSource==='trip'?`trip, ${listTripRates(c.db,c.scope,t.id).find(r=>r.currency===e.currency)?.origin}`:e.fxRateSource).summary; }
  catch { detail=`${JSON.stringify(e.description || e.merchant || 'Expense')} · ${formatAmount(e.total,e.currency)}\nIncomplete draft; does not count toward balances.`; }
  return `${verb} #${e.id}\n${detail}`;
}
