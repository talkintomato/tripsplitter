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
  if(input.currencyNeedsReview && !allowIncomplete) refuse('Which currency is on the receipt? Confirm its currency first.');
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
  const rendered = allowIncomplete && (problems.length > 0 || input.currencyNeedsReview)
    ? { ...summaryFields({icon:'',title:expenseTitle(input),blocks:[{lines:[
        {label:'Total',value:displayAmount(input.total,input.currency!)}, `Paid by ${memberName(c,input.payerId,true)}`,
        'Draft remains unconfirmed; does not count toward balances.',
        ...(input.currencyNeedsReview ? ['⚠️ Check the receipt currency.'] : []), ...problems.map(p=>`⚠️ ${p.message}`),
      ]}]}), preview: { problems } }
    : renderExpense(c,input,t,resolved.rate,resolved.source==='trip' ? `trip, ${origin}` : resolved.source);
  return {input,plans,...rendered,rate:resolved};
}
const splitLabel = (input:ExpenseInput) => input.splitType==='even' ? `Split equally between ${input.shares.length}` : input.splitType==='items' ? 'Split by item' : 'Split by portions';
const rateLabel = (input:ExpenseInput, home:string, rate:string|null, source:string) => input.currency===home ? 'Not needed' : rate===null ? 'Not set' : `1 ${home} = ${rate} ${input.currency} · ${source==='expense'?"this expense's own rate":source.includes('suggested')?'looked up today':'trip rate'}`;
const portions = (c:ToolContext, shares:ExpenseInput['shares']) => [...shares].sort((a,b)=>a.memberId-b.memberId).map(s=>`${memberName(c,s.memberId)} ×${s.weight??1}`).join(', ');
const itemLines = (c:ToolContext,input:ExpenseInput) => (input.items??[]).map(i=>`${i.label}${(i.quantity??1)===1?'':` ×${i.quantity}`}, ${displayAmount(i.amount,input.currency!)}: ${i.shares?.length?i.shares.map(s=>`${memberName(c,s.memberId)}${(s.weight??1)===1?'':` ×${s.weight}`}`).join(', '):'everyone'}`);
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
    Date:displayDate(i.expenseDate,c.now), 'Paid by':memberName(c,i.payerId,personal), Split:splitLabel(i),
    People:[...i.shares].sort((a,b)=>a.memberId-b.memberId).map(s=>memberName(c,s.memberId)).join(', ')||'Nobody',
    Portions:i.splitType==='portions'?portions(c,i.shares):'None', Items:itemLines(c,i).join('; ')||'None',
    ...Object.fromEntries(extras(i)), Rate:rateLabel(i,home,rate,source),
    'Currency checked':i.currencyNeedsReview?'No':'Yes',
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
  const each=full.blocks.find(b=>b.heading==='Each pays');
  let oldAmounts:ReturnType<typeof expenseAmounts>|undefined;
  const t=getTrip(c.db,c.scope,existing.tripId);
  try { oldAmounts=expenseAmounts(c,inputOf(existing),t,existing.fxRate); } catch { /* Incomplete drafts have no valid shares yet. */ }
  const amountText=(amount:number,homeAmount:number|undefined,currency:string)=>`${displayAmount(amount,currency)}${currency!==t.homeCurrency && homeAmount!==undefined?` (≈ ${displayAmount(homeAmount,t.homeCurrency)})`:''}`;
  const next=each?expenseAmounts(c,input,t,rate):undefined;
  const lines=next?Object.entries(next.amounts).map(([id,amount])=>{
    const value=amountText(amount,next.homeAmounts[Number(id)],input.currency!);
    const old=oldAmounts?.amounts[Number(id)];
    const previous=old===undefined?undefined:amountText(old,oldAmounts?.homeAmounts[Number(id)],existing.currency);
    return {bullet:`${memberName(c,Number(id))}: ${previous!==undefined && previous!==value?`${compactBefore(previous,value)} → `:''}${value}`};
  }):undefined;
  const itemChange=changes.some(l=>typeof l!=='string'&&'label' in l&&l.label==='Items');
  const oldItems=itemLines(c,inputOf(existing)),newItems=itemLines(c,input);
  const itemBlocks:Summary['blocks']=itemChange?[{heading:'Items',lines:Array.from({length:Math.max(oldItems.length,newItems.length)},(_,index)=>index).filter(i=>oldItems[i]!==newItems[i]).map(i=>({bullet:`${oldItems[i]??'None'} → ${newItems[i]??'Removed'}`}))}]:[];
  return {...title,blocks:[
    {lines:changes.filter(l=>typeof l==='string'||!('label' in l)||l.label!=='Items')},
    ...(lines?[{heading:'Each pays',lines}]:[{lines:full.blocks.flatMap(b=>b.lines).filter(l=>typeof l==='string'&&(l.includes('Draft remains')||l.startsWith('⚠️')))}]),
    ...itemBlocks,
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
    ...(e.status==='draft'||e.status==='discarded'?['Draft remains unconfirmed; does not count toward balances.']:[]),
  ]}]};
}
