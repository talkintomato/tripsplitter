import { summaryFields, displayAmount, type Summary } from '../summary.js';
import { z } from 'zod';
import * as dbOps from '../../db/index.js';
import { isSupportedCurrency, isValidRate, toMinorUnits, fromMinorUnits, computeShares, convertExpense, validateExpense, amountsToRecord } from '../../core/index.js';
import type { ToolContext, ToolOutcome, PlannedAction } from '../types.js';

export const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const name = z.string().trim().min(1).max(128);
export const currency = z.string().refine(isSupportedCurrency, 'Choose a supported currency.');
export const amount = z.string().trim().regex(/^\d+(\.\d+)?$/).max(40);
export const rate = z.string().refine(isValidRate, 'The rate must be positive with at most six decimal places.');
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(`${v}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === v; }, 'Choose a real date.');
const portion = z.strictObject({ name, weight: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() });
export const expenseFields = z.strictObject({
  description: z.string().trim().max(500), amount, currency, payer: name, date,
  splitType: z.enum(['even','portions','items']), people: z.array(portion).min(1),
  merchant: z.string().trim().max(200).nullable().optional(),
  tax: amount.optional(), taxIncluded: z.boolean().optional(), tip: amount.optional(), serviceCharge: amount.optional(), discount: amount.optional(),
  rateOverride: rate.nullable().optional(),
  items: z.array(z.strictObject({ label: z.string().trim().max(200), amount, quantity: z.number().positive().optional(), people: z.array(portion).optional() })).max(500).optional(),
});
export type ExpenseArgs = z.infer<typeof expenseFields>;
/** A new expense may leave out who paid, when, how it is split, who shares it and its currency; see withNewExpenseDefaults. */
export const newExpenseFields = expenseFields.partial({ amount: true, payer: true, date: true, splitType: true, people: true, currency: true });
/**
 * What a new expense assumes when the message does not say: the total of its items, the person asking paid, today, the trip's home
 * currency, and an equal split between everyone (by item when items are given; items nobody is named on are
 * shared by everyone). The proposal shows each of these, so a wrong guess is one Change away.
 */
export function withNewExpenseDefaults(c: ToolContext, t: dbOps.Trip, a: z.infer<typeof newExpenseFields>): ExpensePatch {
  const code = a.currency ?? t.homeCurrency;
  return {
    ...a,
    amount: a.amount ?? itemsTotal(a, code),
    currency: code,
    payer: a.payer ?? (c.scope.actor.kind === 'member' ? 'me' : undefined),
    date: a.date ?? dbOps.singaporeDate(c.now),
    splitType: a.splitType ?? (a.items?.length ? 'items' : 'even'),
    people: a.people ?? [{ name: 'everyone' }],
  };
}
export type ExpensePatch = Partial<ExpenseArgs>;
/** Without a total, a list of items adds up to it, as long as there are no charges or discounts on top. */
function itemsTotal(a: ExpensePatch, code: string): string {
  const extras = [a.tax, a.tip, a.serviceCharge, a.discount].some(v => v !== undefined && Number(v) !== 0);
  if (!a.items?.length || extras) refuse('What was the total amount?');
  return fromMinorUnits(a.items.reduce((sum, item) => sum + toMinorUnits(item.amount, code), 0), code);
}
export function refuse(message: string): never { throw new dbOps.ValidationError('invalid_input', message); }
export function trip(c: ToolContext, tripId?: number): dbOps.Trip {
  const t = tripId === undefined ? dbOps.getActiveTrip(c.db,c.scope) ?? dbOps.listTrips(c.db,c.scope)[0] : dbOps.getTrip(c.db,c.scope,tripId);
  return t ?? refuse('There is no trip. Open the app to start one.');
}
export function openTrip(t: dbOps.Trip): void { if(t.status !== 'active') refuse('This trip has ended. Reopen it first.'); }
export function resolveNames(c: ToolContext, names: string[]) {
  const members = dbOps.listMembers(c.db,c.scope);
  return names.map(query => {
    const key = query.trim().toLocaleLowerCase();
    const exact = key === 'everyone' ? members.filter(m => m.active) : key === 'me' || key === 'i'
      ? members.filter(m => c.scope.actor.kind === 'member' && m.id === c.scope.actor.memberId)
      : members.filter(m => m.displayName.toLocaleLowerCase() === key || m.username?.toLocaleLowerCase() === key.replace(/^@/,''));
    if (exact.length === 1 || (key === 'everyone' && exact.length > 0)) return { query, status: 'exact' as const, members: exact };
    const candidates = exact.length ? exact : members.filter(m => m.displayName.toLocaleLowerCase().includes(key));
    return { query, status: exact.length > 1 || candidates.length > 1 ? 'ambiguous' as const : 'unknown' as const, candidates: candidates.length ? candidates : members };
  });
}
export function people(c: ToolContext, entries: Array<{name: string; weight?: number}>): dbOps.ShareInput[] {
  const shares: dbOps.ShareInput[] = [];
  for (const entry of entries) {
    const found = resolveNames(c,[entry.name])[0]!;
    if(found.status !== 'exact') refuse(`Which person do you mean by ${JSON.stringify(entry.name)}? Candidates: ${found.candidates.map(m => JSON.stringify(m.displayName)).join(', ')}.`);
    for(const m of found.members) shares.push({ memberId:m.id, weight:entry.weight ?? 1 });
  }
  if(new Set(shares.map(s=>s.memberId)).size !== shares.length) refuse('A person is listed twice.');
  return shares;
}
export function person(c: ToolContext, value: string): number {
  const found = people(c,[{name:value}]);
  return found.length === 1 ? found[0]!.memberId : refuse('Choose one person.');
}
export function inputOf(e: dbOps.ExpenseDetail): dbOps.ExpenseInput {
  return { locationLat:e.locationLat, locationLng:e.locationLng, placeName:e.placeName, locationSource:e.locationSource, payerId:e.payerId, description:e.description, merchant:e.merchant, expenseDate:e.expenseDate, total:e.total, currency:e.currency,
    tax:e.tax, taxIncluded:e.taxIncluded, tip:e.tip, serviceCharge:e.serviceCharge, discount:e.discount, splitType:e.splitType,
    currencyNeedsReview:e.currencyNeedsReview, receiptFileId:e.receiptFileId, rateOverride:e.fxRateSource === 'expense' ? e.fxRate : null,
    shares:e.shares.filter(s=>s.itemId===null).map(s=>({memberId:s.memberId,weight:s.weight})),
    items:e.items.map(i=>({label:i.label,quantity:i.quantity,amount:i.amount,shares:e.shares.filter(s=>s.itemId===i.id).map(s=>({memberId:s.memberId,weight:s.weight}))})) };
}
export function makeInput(c:ToolContext, a:ExpensePatch, existing?:dbOps.ExpenseDetail): dbOps.ExpenseInput {
  const code = a.currency ?? existing?.currency ?? refuse('What currency is the expense in?');
  const base = existing ? inputOf(existing) : undefined;
  const input: dbOps.ExpenseInput = {
    ...(base ?? {}),
    description:a.description ?? base?.description ?? '', merchant:a.merchant !== undefined ? a.merchant : base?.merchant ?? null,
    payerId:a.payer !== undefined ? person(c,a.payer) : base?.payerId ?? refuse('Who paid?'),
    expenseDate:a.date ?? base?.expenseDate ?? refuse('What date was it?'),
    total:a.amount !== undefined ? toMinorUnits(a.amount,code) : base?.total ?? refuse('What was the amount?'),
    currency:code, currencyNeedsReview:a.currency !== undefined ? false : base?.currencyNeedsReview ?? false,
    splitType:a.splitType ?? base?.splitType ?? refuse('How should it be split?'),
    shares:a.people ? people(c,a.people) : base?.shares ?? refuse('Who is included?'),
    rateOverride:a.rateOverride !== undefined ? a.rateOverride : code === existing?.currency ? base?.rateOverride ?? null : null,
    taxIncluded:a.taxIncluded ?? base?.taxIncluded ?? false,
    items:a.items?.map(i=>({label:i.label || 'Item',quantity:i.quantity ?? 1,amount:toMinorUnits(i.amount,code),shares:people(c,i.people ?? [])})) ?? base?.items ?? [],
  };
  // On a currency edit preserve the displayed major amounts, rather than reinterpreting old minor units.
  for(const field of ['tax','tip','serviceCharge','discount'] as const)
    input[field] = toMinorUnits(a[field] ?? (existing ? fromMinorUnits(existing[field],existing.currency) : '0'),code);
  if(existing && code !== existing.currency && a.amount === undefined) input.total = toMinorUnits(fromMinorUnits(existing.total,existing.currency),code);
  if(existing && code !== existing.currency && a.items === undefined) input.items = input.items!.map(i=>({...i,amount:toMinorUnits(fromMinorUnits(i.amount,existing.currency),code)}));
  const included = new Set(input.shares.map(s => s.memberId));
  for (const item of input.items ?? []) {
    if (new Set((item.shares ?? []).map(s => s.memberId)).size !== (item.shares ?? []).length) refuse('A person is listed twice on an item.');
    if (item.shares?.some(s => !included.has(s.memberId))) refuse('A person assigned to an item must be included in the expense.');
  }
  for (const memberId of [input.payerId, ...included]) {
    if (dbOps.getMember(c.db, c.scope, memberId).mergedInto !== null) refuse('This person was merged into another member.');
  }
  return input;
}
export function splitInput(input: dbOps.ExpenseInput) {
  const expense = {...input,tax:input.tax??0,taxIncluded:input.taxIncluded??false,tip:input.tip??0,serviceCharge:input.serviceCharge??0,discount:input.discount??0};
  const items = (input.items??[]).map((i,index)=>({...i,id:index}));
  const shares = [...input.shares.map(s=>({...s,weight:s.weight??1,itemId:null as number|null})),...items.flatMap(i=>(i.shares??[]).map(s=>({...s,weight:s.weight??1,itemId:i.id})))];
  return {expense,items,shares};
}
export function expenseAmounts(c:ToolContext, input:dbOps.ExpenseInput, t:dbOps.Trip, fxRate:string|null) {
  const s=splitInput(input); const problems=validateExpense(s.expense,s.items,s.shares);
  if(problems.length) refuse(problems.map(p=>p.message).join(' '));
  const amounts=computeShares(s.expense,s.items,s.shares);
  const converted=convertExpense({...s.expense,currency:input.currency!,fxRate},amounts,t.homeCurrency);
  return {amounts:amountsToRecord(amounts), homeAmounts:amountsToRecord(converted.shares), homeTotal:displayAmount(converted.total,t.homeCurrency)};
}
export function defineTool<S extends z.ZodType>(name:string, description:string, schema:S, run:(c:ToolContext,args:z.infer<S>)=>ToolOutcome|Promise<ToolOutcome>) {
  return {name,description,schema, async execute(c:ToolContext,args:unknown):Promise<ToolOutcome>{
    dbOps.getGroup(c.db,c.scope);
    if(c.scope.actor.kind !== 'member' || dbOps.getMember(c.db,c.scope,c.scope.actor.memberId).mergedInto !== null) throw new dbOps.PermissionError();
    return run(c,schema.parse(args));
  }};
}
export const read = (data:unknown):ToolOutcome=>({kind:'read',data});
export const plan = (action:PlannedAction['action'],summary:Summary,confirmLabel:string):ToolOutcome=>({kind:'proposal',plans:[{action,...summaryFields(summary),confirmLabel}]});

export const memberName = (c:ToolContext, memberId:number, personal = c.personalNames ?? false) => personal && c.scope.actor.kind === "member" && c.scope.actor.memberId === memberId ? "you" : dbOps.getMember(c.db,c.scope,memberId).displayName;
