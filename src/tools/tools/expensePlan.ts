import { getExpense, getTrip, listTripRates, previewTripRate, type ExpenseDetail, type ExpenseInput } from '../../db/index.js';
import { resolveRate, isValidRate, validateExpense } from '../../core/index.js';
import { inputOf, makeInput, expenseAmounts, memberName, openTrip, refuse, splitInput, type ExpensePatch } from './shared.js';
import { displayAmount, displayDate, summaryFields, type Summary, type Line } from '../summary.js';
import type { ToolContext, PlannedAction } from '../types.js';

export const expenseTitle = (input: ExpenseInput) => input.description || input.merchant || 'Expense';
export function ratePlan(c:ToolContext, tripId:number, currency:string, rate:string, origin:'member'|'suggested'): PlannedAction {
  const t=getTrip(c.db,c.scope,tripId);
  const preview=previewTripRate(c.db,c.scope,tripId,currency,rate);
  return {action:{kind:'set_trip_rate',tripId,currency,rate,origin,snapshot:preview.snapshot},confirmLabel:'Set rate',
    ...summaryFields({icon:'💱',title:`Exchange rate · ${currency}`,blocks:[{lines:[
      `Rate: 1 ${t.homeCurrency} = ${rate} ${currency} · ${origin==='suggested'?'looked up today':'trip rate'}`,
      `⚠️ Changes ${preview.expensesChanged} ${preview.expensesChanged===1?'expense':'expenses'} already saved`,
    ]}]})};
}
export async function prepareExpense(c:ToolContext, tripId:number, args:ExpensePatch, existing?:ExpenseDetail, allowIncomplete = false) {
  const t=getTrip(c.db,c.scope,tripId); openTrip(t);
  const input=makeInput(c,args,existing);
  const tripRate=listTripRates(c.db,c.scope,t.id).find(r=>r.currency===input.currency);
  let resolved=resolveRate({expenseCurrency:input.currency!,homeCurrency:t.homeCurrency,expenseOverride:input.rateOverride,tripRate:tripRate?.rate});
  const plans:PlannedAction[]=[];
  let origin='';
  if(resolved.source==='missing') {
    let suggested:string|null=null;
    try { suggested=await c.suggestRate(t.homeCurrency,input.currency!); } catch { /* Ask for a rate; never log user data. */ }
    if(!isValidRate(suggested)) refuse(`What is the rate for ${input.currency} per 1 ${t.homeCurrency}? I couldn't look it up.`);
    plans.push(ratePlan(c,t.id,input.currency!,suggested,'suggested'));
    resolved=resolveRate({expenseCurrency:input.currency!,homeCurrency:t.homeCurrency,tripRate:suggested}); origin='suggested';
  }
  const split = splitInput(input);
  const problems = validateExpense(split.expense, split.items, split.shares);
  const rendered = allowIncomplete && problems.length > 0
    ? { ...summaryFields({icon:'',title:expenseTitle(input),blocks:[{lines:[
        {label:'Total',value:displayAmount(input.total,input.currency!)}, `Paid by ${memberName(c,input.payerId,true)}`,
        DRAFT_NOTE,
        ...(input.currencyNeedsReview ? [CURRENCY_NOTE] : []), ...problems.map(p=>`⚠️ ${p.message}`),
      ]}]}), preview: { problems } }
    : renderExpense(c,input,t,resolved.rate,resolved.source==='trip' ? `trip, ${origin}` : resolved.source);
  return {input,plans,...rendered,rate:resolved};
}
const splitLabel = (input:ExpenseInput) => input.splitType==='even' ? `Split equally between ${input.shares.length}` : input.splitType==='items' ? 'Split by item' : 'Split by portions';
const rateLabel = (input:ExpenseInput, home:string, rate:string|null, source:string) => input.currency===home ? 'Not needed' : rate===null ? 'Not set' : `1 ${home} = ${rate} ${input.currency} · ${source==='expense'?"this expense's own rate":source.includes('suggested')?'looked up today':'trip rate'}`;
const portions = (c:ToolContext, shares:ExpenseInput['shares']) => [...shares].sort((a,b)=>a.memberId-b.memberId).map(s=>`${memberName(c,s.memberId)} ×${s.weight??1}`).join(', ');
const DRAFT_NOTE = "Still a draft: it won't count until it's approved.";
const CURRENCY_NOTE = 'Currency read from the receipt. Change it if it’s wrong.';
/**
 * An item's name as people would say it: without a leading menu code such as "153-2 " or "A12 ",
 * and cut to 34 characters so one item stays on one line on a phone.
 */
export function itemName(label:string):string {
  const plain=label.replace(/^[A-Z]?\d+[A-Z]?(?:[-.]\d+)?[.)]?\s+(?=\S)/i,'').trim()||label.trim();
  return [...plain].length>34 ? `${[...plain].slice(0,33).join('').trimEnd()}…` : plain;
}
/** Who had an item: "Sam, Ana ×2", or "everyone" when nobody is assigned. */
const whoHad = (c:ToolContext, shares:NonNullable<ExpenseInput['items']>[number]['shares']) =>
  shares?.length ? shares.map(s=>`${memberName(c,s.memberId)}${(s.weight??1)===1?'':` ×${s.weight}`}`).join(', ') : 'everyone';
/** "Carrot Cake (2pcs) · 3.10 SGD" */
const itemHead = (i:NonNullable<ExpenseInput['items']>[number], currency:string) =>
  `${itemName(i.label)}${(i.quantity??1)===1?'':` ×${i.quantity}`} · ${displayAmount(i.amount,currency)}`;
const itemLines = (c:ToolContext,input:ExpenseInput) => (input.items??[]).map(i=>`${itemHead(i,input.currency!)}: ${whoHad(c,i.shares)}`);
const extras = (input:ExpenseInput) => [
  ['Tax',`${displayAmount(input.tax??0,input.currency!)}${input.taxIncluded?' (in the prices)':''}`],
  ['Tip',displayAmount(input.tip??0,input.currency!)], ['Service charge',displayAmount(input.serviceCharge??0,input.currency!)], ['Discount',displayAmount(input.discount??0,input.currency!)],
] as const;
/** All amounts and conversions come from foundation previews. */
export function renderExpense(c:ToolContext,input:ExpenseInput,t:ReturnType<typeof getTrip>,fxRate:string|null,source:string) {
  const preview=expenseAmounts(c,input,t,fxRate);
  const foreign=input.currency!==t.homeCurrency;
  const blocks:Summary['blocks']=[{lines:[
    {label:'Total',value:`${displayAmount(input.total,input.currency!)}${foreign?` (≈ ${preview.homeTotal})`:''}`},
    `Paid by ${memberName(c,input.payerId,true)}`, {label:'Date',value:displayDate(input.expenseDate,c.now)}, splitLabel(input),
    ...(foreign?[{label:'Rate',value:rateLabel(input,t.homeCurrency,fxRate,source)}]:[]),
    ...(input.merchant && input.merchant!==input.description?[{label:'Merchant',value:input.merchant}]:[]),
  ]}, {heading:'Each pays',lines:Object.entries(preview.amounts).map(([id,amount])=>({bullet:`${memberName(c,Number(id))}: ${displayAmount(amount,input.currency!)}${foreign?` (≈ ${displayAmount(preview.homeAmounts[Number(id)]!,t.homeCurrency)})`:''}`}))}];
  if(input.items?.length)blocks.push({heading:'Items',lines:itemLines(c,input).map(bullet=>({bullet}))});
  if(input.splitType==='portions')blocks.push({heading:'Portions',lines:input.shares.map(s=>({bullet:`${memberName(c,s.memberId)}: ${s.weight??1}`}))});
  const extraLines=extras(input).filter((_,i)=>[input.tax,input.tip,input.serviceCharge,input.discount][i]).map(([label,value])=>({label,value}));
  if(extraLines.length)blocks.push({lines:extraLines});
  return {...summaryFields({icon:'',title:expenseTitle(input),blocks}),preview};
}
export function expenseChanges(c:ToolContext,before:ExpenseDetail,input:ExpenseInput,fxRate:string|null,source:string,personal=true):Line[] {
  const old=inputOf(before),home=getTrip(c.db,c.scope,before.tripId).homeCurrency;
  const total=(i:ExpenseInput,rate:string|null)=>{
    let value=displayAmount(i.total,i.currency!);
    if(i.currency!==home) {
      try { value+=` (≈ ${expenseAmounts(c,i,getTrip(c.db,c.scope,before.tripId),rate).homeTotal})`; } catch { /* An incomplete draft has no home preview. */ }
    }
    return value;
  };
  const fields=(i:ExpenseInput,rate:string|null,source:string):Record<string,string>=>({
    Description:i.description||'', Merchant:i.merchant||'None', Total:total(i,rate), Currency:i.currency!,
    Date:displayDate(i.expenseDate,c.now), 'Paid by':memberName(c,i.payerId,personal),
    Split:i.splitType==='even'?`equally between ${i.shares.length}`:i.splitType==='items'?'by item':'by portions',
    People:[...i.shares].sort((a,b)=>a.memberId-b.memberId).map(s=>memberName(c,s.memberId)).join(', ')||'Nobody',
    Portions:i.splitType==='portions'?portions(c,i.shares):'None', Items:itemLines(c,i).join('; ')||'None',
    ...Object.fromEntries(extras(i)), Rate:rateLabel(i,home,rate,source),
  });
  const a=fields(old,before.fxRate,before.fxRateSource),b=fields(input,fxRate,source);
  const shareKey=(shares:ExpenseInput['shares'],weights=false)=>JSON.stringify([...shares].sort((a,b)=>a.memberId-b.memberId).map(s=>[s.memberId,...(weights?[s.weight??1]:[])]));
  const itemKey=(i:ExpenseInput)=>JSON.stringify((i.items??[]).map(item=>[item.label,item.quantity??1,item.amount,shareKey(item.shares??[],true)]));
  const differs=(label:string):boolean=>{
    if(label==='Total')return old.total!==input.total || old.currency!==input.currency;
    if(label==='Paid by')return old.payerId!==input.payerId;
    if(label==='People')return shareKey(old.shares)!==shareKey(input.shares);
    if(label==='Portions')return (old.splitType==='portions'||input.splitType==='portions') && (old.splitType!==input.splitType || shareKey(old.shares,true)!==shareKey(input.shares,true));
    if(label==='Items')return itemKey(old)!==itemKey(input);
    if(label==='Split')return old.splitType!==input.splitType;
    return a[label]!==b[label];
  };
  return Object.keys(b).filter(differs).map(label=>({label,before:['Total','Tax','Tip','Service charge','Discount'].includes(label)?compactBefore(a[label]!,b[label]!):a[label]!,after:b[label]!}));
}
/** Omit a repeated currency suffix in an amount change. */
const compactBefore = (before:string,after:string) => / [A-Z]{3}$/.test(before) && before.slice(-4)===after.slice(-4) ? before.slice(0,-4) : before;
export function renderChange(c:ToolContext,existing:ExpenseDetail,input:ExpenseInput,rate:string|null,source:string,full:Summary,approve=false):Summary {
  const changes=expenseChanges(c,existing,input,rate,source);
  if(!changes.length && !approve)refuse("That's already how it is.");
  const title={icon:approve?'✅':'✏️',title:`${approve?'Approve':'Change'} ${expenseTitle(input)}`};
  if(approve && (!changes.length || (existing.fxRateSource==='missing' && changes.every(line=>typeof line!=='string' && 'label' in line && line.label==='Rate'))))return {...full,...title};
  const t=getTrip(c.db,c.scope,existing.tripId);
  let oldAmounts:ReturnType<typeof expenseAmounts>|undefined;
  try { oldAmounts=expenseAmounts(c,inputOf(existing),t,existing.fxRate); } catch { /* Incomplete drafts have no valid shares yet. */ }
  let next:ReturnType<typeof expenseAmounts>|undefined;
  try { next=expenseAmounts(c,input,t,rate); } catch { /* Not splittable yet: the problems are listed instead. */ }
  const amountText=(amount:number,homeAmount:number|undefined,currency:string)=>`${displayAmount(amount,currency)}${currency!==t.homeCurrency && homeAmount!==undefined?` (≈ ${displayAmount(homeAmount,t.homeCurrency)})`:''}`;
  const lines=next?Object.entries(next.amounts).map(([id,amount])=>{
    const value=amountText(amount,next!.homeAmounts[Number(id)],input.currency!);
    const old=oldAmounts?.amounts[Number(id)];
    const previous=old===undefined?undefined:amountText(old,oldAmounts?.homeAmounts[Number(id)],existing.currency);
    return {bullet:`${memberName(c,Number(id))}: ${previous!==undefined && previous!==value?`${compactBefore(previous,value)} → `:''}${value}`};
  }):undefined;

  // Items: one line per item that changed. When only who had it changed, just the item and who has it now.
  const itemChange=changes.some(l=>typeof l!=='string'&&'label' in l&&l.label==='Items');
  const oldList=inputOf(existing).items??[], newList=input.items??[];
  const itemBullets:Line[]=[];
  for(let index=0;index<Math.max(oldList.length,newList.length);index++){
    const before=oldList[index], after=newList[index];
    if(!after){ itemBullets.push({bullet:`${itemHead(before!,existing.currency)}: removed`}); continue; }
    if(!before){ itemBullets.push({bullet:`${itemHead(after,input.currency!)}: ${whoHad(c,after.shares)} (new)`}); continue; }
    const sameItem=before.label===after.label && before.amount===after.amount && (before.quantity??1)===(after.quantity??1);
    const oldWho=whoHad(c,before.shares), newWho=whoHad(c,after.shares);
    if(sameItem && oldWho===newWho) continue;
    if(sameItem) itemBullets.push({bullet:`${itemHead(after,input.currency!)}: ${oldWho==='everyone'?newWho:`${oldWho} → ${newWho}`}`});
    else itemBullets.push({bullet:`${itemHead(before,existing.currency)} → ${itemHead(after,input.currency!)}: ${newWho}`});
  }
  const notes=full.blocks.flatMap(b=>b.lines).filter((l):l is string=>typeof l==='string'&&(l===DRAFT_NOTE||l.startsWith('⚠️')));
  if(input.currencyNeedsReview && !approve && !notes.includes(CURRENCY_NOTE)) notes.push(CURRENCY_NOTE);
  if(existing.status==='draft' && !approve && !notes.includes(DRAFT_NOTE)) notes.unshift(DRAFT_NOTE);
  const main=changes.filter(l=>typeof l==='string'||!('label' in l)||l.label!=='Items');
  return {...title,blocks:[
    ...(main.length?[{lines:main}]:[]),
    ...(itemChange&&itemBullets.length?[{heading:'Who had what',lines:itemBullets}]:[]),
    ...(lines?[{heading:'Each pays',lines}]:[]),
    ...(notes.length?[{lines:notes}]:[]),
  ]};
}
export async function changeExpense(c:ToolContext, kind:'edit_expense'|'approve_draft'|'set_expense_rate', expenseId:number, changes:ExpensePatch) {
  const existing=getExpense(c.db,c.scope,expenseId);
  if(kind==='approve_draft' ? existing.status!=='draft' : !['draft','confirmed'].includes(existing.status)) refuse(kind==='approve_draft'?'Only a receipt draft can be approved.':'Restore the expense before changing it.');
  const prepared=await prepareExpense(c,existing.tripId,changes,existing,existing.status==='draft' && kind!=='approve_draft');
  const summary=renderChange(c,existing,prepared.input,prepared.rate.rate,prepared.rate.source,prepared.structuredSummary,kind==='approve_draft');
  return {kind:'proposal' as const, plans:[...prepared.plans,{action:{kind,expenseId,input:prepared.input},...summaryFields(summary),confirmLabel:kind==='approve_draft'?'Approve it':kind==='set_expense_rate'?'Set rate':'Change it'}]};
}
export function removalSummary(c:ToolContext, verb:string, e:ExpenseDetail):Summary {
  const icon=verb==='Delete'?'🗑️':verb==='Restore'?'♻️':'✖️';
  return {icon,title:`${verb} ${expenseTitle(inputOf(e))}`,blocks:[{lines:[
    {label:'Total',value:displayAmount(e.total,e.currency)},
    ...(verb==='Delete'?['⚠️ Removes this expense from balances. It can be restored.']:[]),
    ...(e.status==='draft'||e.status==='discarded'?[DRAFT_NOTE]:[]),
  ]}]};
}
