import { combineSummaries, summaryFields, toPlainText, lineText } from './summary.js';
import * as ops from '../db/index.js';
import { computeShares, toSafeNumber, type ExpenseNotice } from '../core/index.js';
import { inputOf } from './tools/shared.js';
import { renderExpense, renderChange, expenseChanges } from './tools/expensePlan.js';
import { resolveRate } from '../core/index.js';
import type { PlannedAction, ProposalVersions, ConfirmationResult, AgentNotice, Action } from './types.js';

export function proposalVersions(db:ops.Db, scope:ops.Scope):ProposalVersions {
  const expenses:Record<number,number>={}, settlements:Record<number,number>={};
  for(const trip of ops.listTrips(db,scope)) {
    for(const e of ops.listExpenses(db,scope,trip.id,{status:['draft','confirmed','deleted','discarded']})) expenses[e.id]=e.version;
    for(const s of ops.listSettlements(db,scope,trip.id)) settlements[s.id]=s.version;
  }
  return {revision:ops.listActivity(db,scope,{limit:1})[0]?.id??0,expenses,settlements};
}
/** Keep one suggested rate per currency; refuse conflicting previews instead of showing misleading totals. */
export function combinePlans(plans:PlannedAction[]):PlannedAction[] {
  const result:PlannedAction[]=[];
  const targets=new Set<string>();
  for(const plan of plans) {
    const a=plan.action;
    if(a.kind==='set_trip_rate') {
      const earlier=result.find(p=>p.action.kind==='set_trip_rate'&&p.action.tripId===a.tripId&&p.action.currency===a.currency);
      if(earlier) {
        if(earlier.action.kind==='set_trip_rate'&&earlier.action.rate===a.rate&&earlier.action.origin===a.origin) continue;
        throw new ops.ValidationError('invalid_input','Ask for one rate per currency in a proposal.');
      }
    }
    const key='expenseId' in a?`expense:${a.expenseId}`:'settlementId' in a?`settlement:${a.settlementId}`:undefined;
    if(key&&targets.has(key)) throw new ops.ValidationError('invalid_input','Combine changes to the same record in one tool call.');
    if(key)targets.add(key);
    result.push(plan);
  }
  return result;
}
export const proposalSummary = (plans:PlannedAction[]) => combineSummaries(plans.map(p=>p.structuredSummary));
export function summariseProposal(plans:PlannedAction[]):string { return toPlainText(proposalSummary(plans)); }
export function createAgentProposal(db:ops.Db, scope:ops.Scope, input:{chatId:number;plans:PlannedAction[];versions:ProposalVersions;now:Date}) {
  const plans=combinePlans(input.plans);
  if(!plans.length) throw new ops.ValidationError('invalid_input','There are no changes to confirm.');
  // Preview against proposed rates while preserving the requested display order.
  for(const p of plans) if('input' in p.action || 'expenseId' in p.action) {
    const action=p.action;
    const tripId='tripId' in action?action.tripId:ops.getExpense(db,scope,action.expenseId).tripId;
    const t=ops.getTrip(db,scope,tripId);
    const expenseInput = 'input' in action ? action.input : inputOf(ops.getExpense(db,scope,action.expenseId));
    const proposed=plans.find(q=>q.action.kind==='set_trip_rate'&&q.action.tripId===tripId&&q.action.currency===expenseInput.currency)?.action;
    if(proposed?.kind==='set_trip_rate') {
      const resolved=resolveRate({expenseCurrency:expenseInput.currency!,homeCurrency:t.homeCurrency,expenseOverride:expenseInput.rateOverride,tripRate:proposed.rate});
      const c={db,scope,now:input.now,suggestRate:async()=>null};
      try {
        const rendered=renderExpense(c,expenseInput,t,resolved.rate,resolved.source==='trip'?`trip, ${proposed.origin}`:resolved.source);
        if ('input' in action) {
          const summary = action.kind==='add_expense'
            ? {...rendered.structuredSummary,icon:'➕',title:`Add ${rendered.structuredSummary.title}`}
            : renderChange(c,ops.getExpense(db,scope,action.expenseId),action.input,resolved.rate,resolved.source,rendered.structuredSummary,action.kind==='approve_draft');
          Object.assign(p,summaryFields(summary));
        }
      } catch(error) {
        // An incomplete receipt draft stays a draft when edited, discarded or restored.
        if ('expenseId' in action && ops.getExpense(db,scope,action.expenseId).status !== 'confirmed' && action.kind !== 'approve_draft') continue;
        throw error;
      }
    }
  }
  const revision=ops.listActivity(db,scope,{limit:1})[0]?.id??0;
  if(revision!==input.versions.revision) throw new ops.ValidationError('invalid_input','This changed since I prepared it. Ask me again.');
  return ops.createProposal(db,scope,{chatId:input.chatId,actions:plans,summary:summariseProposal(plans),versions:input.versions,now:input.now});
}
function expenseNotice(db:ops.Db,scope:ops.Scope,e:ops.ExpenseDetail):ExpenseNotice {
  const actor=scope.actor;
  if(actor.kind!=='member')throw new ops.PermissionError();
  return {chatId:ops.getGroup(db,scope).chatId,groupId:scope.groupId,actorName:ops.getMember(db,scope,actor.memberId).displayName,
    expenseId:e.id,description:e.description||e.merchant||'Expense',total:e.total,currency:e.currency,splitType:e.splitType,
    shares:[...computeShares(e,e.items,e.shares)].map(([id,amount])=>({name:ops.getMember(db,scope,id).displayName,amount:toSafeNumber(amount)}))};
}
function execute(db:ops.Db,scope:ops.Scope,a:Action,notices:AgentNotice[]):void {
  if(scope.actor.kind!=='member')throw new ops.PermissionError();
  const common={chatId:ops.getGroup(db,scope).chatId,actorName:ops.getMember(db,scope,scope.actor.memberId).displayName};
  switch(a.kind) {
    case 'add_expense': {
      const e=ops.createExpense(db,scope,{...a.input,tripId:a.tripId,status:'confirmed'});
      notices.push({method:'expenseSaved',payload:expenseNotice(db,scope,e)});break;
    }
    case 'edit_expense': case 'set_expense_rate': case 'approve_draft': {
      const before=ops.getExpense(db,scope,a.expenseId);
      if(a.kind==='approve_draft' ? before.status!=='draft' : !['draft','confirmed'].includes(before.status)) throw new ops.ValidationError('invalid_status','The expense status changed.');
      let e=ops.saveExpense(db,scope,before.id,before.version,a.input);
      if(a.kind==='approve_draft')e=ops.confirmExpense(db,scope,e.id,e.version);
      if (e.status==='confirmed') notices.push(a.kind==='approve_draft'?{method:'expenseSaved',payload:expenseNotice(db,scope,e)}:
        {method:'expenseEdited',payload:{...expenseNotice(db,scope,e),changes:expenseChanges({db,scope,now:new Date(),suggestRate:async()=>null},before,inputOf(e),e.fxRate,e.fxRateSource,false).map(lineText)}});break;
    }
    case 'discard_draft': case 'delete_expense': case 'restore_expense': {
      const before=ops.getExpense(db,scope,a.expenseId);
      const operation=a.kind==='discard_draft'?ops.discardExpense:a.kind==='delete_expense'?ops.deleteExpense:ops.restoreExpense;
      const e=operation(db,scope,before.id,before.version);
      if(a.kind==='delete_expense')notices.push({method:'expenseDeleted',payload:expenseNotice(db,scope,e)});
      if(a.kind==='restore_expense'&&e.status==='confirmed')notices.push({method:'expenseRestored',payload:expenseNotice(db,scope,e)});
      break;
    }
    case 'record_payment': case 'undo_payment': {
      const old=a.kind==='undo_payment'?ops.getSettlement(db,scope,a.settlementId):undefined;
      const s=a.kind==='record_payment'?ops.createSettlement(db,scope,a):ops.undoSettlement(db,scope,old!.id,old!.version);
      const payload={...common,fromName:ops.getMember(db,scope,s.fromMemberId).displayName,toName:ops.getMember(db,scope,s.toMemberId).displayName,
        amount:s.amount,currency:ops.getTrip(db,scope,s.tripId).homeCurrency};
      notices.push({method:a.kind==='record_payment'?'settlementRecorded':'settlementUndone',payload});break;
    }
    case 'add_member': ops.addManualMember(db,scope,a.name);break;
    case 'set_trip_rate': {
      const result=ops.setTripRate(db,scope,a.tripId,a.currency,a.rate,a.origin,a.snapshot);
      if(result.changed)notices.push({method:'tripRateChanged',payload:{...common,homeCurrency:ops.getTrip(db,scope,a.tripId).homeCurrency,
        currency:a.currency,rate:a.rate,origin:a.origin,expensesChanged:result.changedExpenses.length}});break;
    }
    case 'rename_trip':ops.renameTrip(db,scope,a.tripId,a.name);break;
    case 'end_trip': case 'reopen_trip': {
      const t=a.kind==='end_trip'?ops.endTrip(db,scope,a.tripId):ops.reopenTrip(db,scope,a.tripId);
      notices.push({method:a.kind==='end_trip'?'tripEnded':'tripReopened',payload:{...common,tripName:t.name}});break;
    }
  }
}
export interface ProposalDecision { proposalId:string; memberId:number; now:Date }
/** Reserved deps argument for Phase B; returns notices, does not send them. */
export type ConfirmationDeps = Record<string, never>;
function decide(db:ops.Db,input:ProposalDecision,cancel:boolean):ConfirmationResult {
  try {
    return db.transaction(():ConfirmationResult=>{
      const p=ops.getProposal(db,input.proposalId);
      if(!p)return {kind:'refused',reason:'That offer does not exist.'};
      if(p.memberId!==input.memberId)return {kind:'not_yours',text:`Only ${ops.getMember(db,ops.memberScope(p.groupId,p.memberId),p.memberId).displayName} can confirm this.`};
      const scope=ops.memberScope(p.groupId,p.memberId);
      if(p.status==='done')return {kind:'already_done',text:'Already done.'};
      if(p.status==='cancelled')return {kind:'refused',reason:'That offer was cancelled.'};
      if(!Number.isFinite(input.now.getTime()))return {kind:'refused',reason:'The time is not valid.'};
      if(p.status==='expired'||p.expiresAt<=input.now.toISOString()) {
        ops.finishProposal(db,scope,p.id,'expired');return {kind:'expired',text:'That offer expired. Ask me again.'};
      }
      if(cancel) {ops.finishProposal(db,scope,p.id,'cancelled');return {kind:'done',notices:[]};}
      const versions=p.versions as ProposalVersions;
      if(JSON.stringify(proposalVersions(db,scope))!==JSON.stringify(versions))return {kind:'changed',text:'This changed since I prepared it. Ask me again.'};
      const notices:AgentNotice[]=[];
      for(const plan of [...p.actions as PlannedAction[]].sort((a,b)=>Number(b.action.kind==='set_trip_rate')-Number(a.action.kind==='set_trip_rate')))execute(db,scope,plan.action,notices);
      if(!ops.finishProposal(db,scope,p.id,'done'))throw new Error('Could not finish proposal.');
      return {kind:'done',notices};
    }).immediate();
  } catch(error) {
    if(error instanceof ops.StaleEditError)return {kind:'changed',text:'This changed since I prepared it. Ask me again.'};
    return {kind:'refused',reason:error instanceof ops.DomainError?error.message:'The changes could not be applied. Ask me again.'};
  }
}
export function confirmProposal(db:ops.Db,_deps:ConfirmationDeps,input:ProposalDecision):ConfirmationResult {return decide(db,input,false);}
export const applyProposal=confirmProposal;
export function cancelProposal(db:ops.Db,_deps:ConfirmationDeps,input:ProposalDecision):ConfirmationResult {return decide(db,input,true);}
/**
 * Applies planned changes straight away, without a stored proposal: the MCP server's path, where the client asks
 * the person before calling a changing tool. Same operations, checks and notices as confirming a proposal.
 * `versions` is what the plans were prepared from; any change to the group since then refuses them.
 */
export function applyPlans(db:ops.Db,scope:ops.Scope,input:{plans:PlannedAction[];versions:ProposalVersions}):ConfirmationResult {
  try {
    const plans=combinePlans(input.plans);
    if(!plans.length)return {kind:'refused',reason:'There are no changes to make.'};
    plans.sort((a,b)=>Number(b.action.kind==='set_trip_rate')-Number(a.action.kind==='set_trip_rate'));
    return db.transaction(():ConfirmationResult=>{
      if(JSON.stringify(proposalVersions(db,scope))!==JSON.stringify(input.versions))return {kind:'changed',text:'This changed while it was being prepared. Try again.'};
      const notices:AgentNotice[]=[];
      for(const plan of plans)execute(db,scope,plan.action,notices);
      return {kind:'done',notices};
    }).immediate();
  } catch(error) {
    if(error instanceof ops.StaleEditError)return {kind:'changed',text:'This changed while it was being prepared. Try again.'};
    return {kind:'refused',reason:error instanceof ops.DomainError?error.message:'The changes could not be applied.'};
  }
}
