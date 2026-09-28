import { runAgentTurn } from '../../src/agent/index.js';
import { afterEach, expect, it, vi } from 'vitest';
import * as d from '../../src/db/index.js';
import { confirmProposal, runTool } from '../../src/tools/index.js';
import { fixture, expense, expenseArgs, fingerprint, prepare, turn, now, type Fixture } from '../agent/helpers.js';
import { ScriptedAgentModel, calls, text } from '../agent/fakeModel.js';
const opened:Fixture[]=[];const make=()=>{const f=fixture();opened.push(f);return f;};
afterEach(()=>opened.splice(0).forEach(f=>f.db.close()));
const jpy={...expenseArgs,currency:'JPY',amount:'1200'};
it('uses a trip rate without suggesting another, with an exact zero-decimal summary',async()=>{
 const f=make();d.setTripRate(f.db,f.scope,f.trip.id,'JPY','100','member');
 f.context.suggestRate=vi.fn(async()=>null);
 const {p,before,after}=await prepare(f,'add_expense',jpy);
 expect(after).toBe(before);expect(f.context.suggestRate).not.toHaveBeenCalled();
 expect(p.summary).toBe('Add expense\n"Taxi" · 1200 JPY\nPaid by "Sam" · 2026-09-28 · even split\n"Sam": 600 JPY; "Alex": 600 JPY\nHome total: 12.00 SGD · 1 SGD = 100 JPY (trip, member)\n"Sam": 6.00 SGD; "Alex": 6.00 SGD');
 expect(confirmProposal(f.db,{}, {proposalId:p.id,memberId:f.member.id,now}).kind).toBe('done');
});
it('a suggestion is a rate action plus a confirmed expense, both unchanged until confirmation',async()=>{
 const f=make();const draft=expense(f,'draft',{currency:'JPY',total:1200});
 f.context.suggestRate=vi.fn(async()=> '100');
 const {p,before,after}=await prepare(f,'approve_draft',{expenseId:draft.id});
 expect(after).toBe(before);expect(f.context.suggestRate).toHaveBeenCalledWith('SGD','JPY');
 expect(p.summary).toBe('Set trip rate: 1 SGD = 100 JPY (suggested).\nWarning: changing the trip rate will update 1 expenses (0 confirmed).\n\nApprove draft #1\n"Taxi" · 1200 JPY\nPaid by "Sam" · 2026-09-28 · even split\n"Sam": 600 JPY; "Alex": 600 JPY\nHome total: 12.00 SGD · 1 SGD = 100 JPY (trip, suggested)\n"Sam": 6.00 SGD; "Alex": 6.00 SGD');
 const done=confirmProposal(f.db,{}, {proposalId:p.id,memberId:f.member.id,now});
 expect(done.kind==='done'&&done.notices.map(n=>n.method)).toEqual(['tripRateChanged','expenseSaved']);
 expect(d.getExpense(f.db,f.scope,draft.id)).toMatchObject({status:'confirmed',fxRate:'100',fxRateSource:'trip'});
 expect(d.listTripRates(f.db,f.scope,f.trip.id)[0]).toMatchObject({origin:'suggested',setBy:f.member.id});
});
it.each([null,'invalid','0'])('asks for a rate when suggestion is %s, leaving all foundation data unchanged',async rate=>{
 const f=make(),before=fingerprint(f.db,true);f.context.suggestRate=async()=>rate;
 const {result}=await turn(f,'add_expense',jpy);
 expect(result).toEqual({kind:'reply',text:"What is the rate for JPY per 1 SGD? I couldn't look it up."});
 expect(fingerprint(f.db,true)).toBe(before);expect(f.db.prepare('SELECT * FROM agent_proposal').all()).toEqual([]);
});
it('a rate suggester throwing is handled like no rate',async()=>{
 const f=make();f.context.suggestRate=async()=>{throw new Error('provider unavailable');};
 const {result}=await turn(f,'add_expense',jpy);expect(result).toMatchObject({kind:'reply',text:expect.stringContaining('What is the rate')});
});
it('clears an expense override and returns to the trip rate',async()=>{
 const f=make();d.setTripRate(f.db,f.scope,f.trip.id,'JPY','100','member');
 const e=expense(f,'confirmed',{currency:'JPY',total:1200,rateOverride:'120'});
 const {p}=await prepare(f,'set_expense_rate',{expenseId:e.id,rate:null});
 expect(p.summary).toContain('100 JPY (trip, member)');
 expect(confirmProposal(f.db,{}, {proposalId:p.id,memberId:f.member.id,now}).kind).toBe('done');
 expect(d.getExpense(f.db,f.scope,e.id)).toMatchObject({fxRate:'100',fxRateSource:'trip'});
});
it('deduplicates suggested rates across several expense actions',async()=>{
 const f=make();const model=new ScriptedAgentModel([calls(['add_expense',jpy],['add_expense',{...jpy,description:'Train'}]),text()]);
 const result=await runAgentTurn(f.db,f.config,{model,suggestRate:async()=> '100'},{groupId:f.g.group.id,memberId:f.member.id,chatId:-100,text:'Two expenses',now});
 expect(result.kind).toBe('proposal');if(result.kind!=='proposal')return;
 expect(result.summary.match(/Set trip rate/g)).toHaveLength(1);
 const done=confirmProposal(f.db,{}, {proposalId:result.proposalId,memberId:f.member.id,now});
 expect(done.kind==='done'&&done.notices.map(n=>n.method)).toEqual(['tripRateChanged','expenseSaved','expenseSaved']);
});
it('combines an explicit rate change and expense with totals previewed at the new rate',async()=>{
 const f=make();d.setTripRate(f.db,f.scope,f.trip.id,'JPY','100','member');
 const model=new ScriptedAgentModel([calls(['add_expense',jpy],['set_trip_rate',{currency:'JPY',rate:'120'}]),text()]);
 const result=await runAgentTurn(f.db,f.config,{model,suggestRate:async()=>null},{groupId:f.g.group.id,memberId:f.member.id,chatId:-100,text:'Change rate and add taxi',now});
 expect(result.kind).toBe('proposal');if(result.kind!=='proposal')return;
 expect(result.summary).toContain('Home total: 10.00 SGD · 1 SGD = 120 JPY (trip, member)');
 expect(confirmProposal(f.db,{}, {proposalId:result.proposalId,memberId:f.member.id,now}).kind).toBe('done');
 expect(d.getExpense(f.db,f.scope,1)).toMatchObject({fxRate:'120'});
});
it('trip-rate preview count and stale guard cover follower versions and new expenses',async()=>{
 const f=make();d.setTripRate(f.db,f.scope,f.trip.id,'JPY','100','member');expense(f,'confirmed',{currency:'JPY',total:1200});
 expense(f,'confirmed',{currency:'JPY',total:1200,rateOverride:'90'});
 const {p,before,after}=await prepare(f,'set_trip_rate',{currency:'JPY',rate:'120'});
 expect(after).toBe(before);expect(p.summary).toContain('1 expenses (1 confirmed)');
 expense(f,'confirmed',{currency:'JPY',total:1000});
 expect(confirmProposal(f.db,{}, {proposalId:p.id,memberId:f.member.id,now}).kind).toBe('changed');
});
