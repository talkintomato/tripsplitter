import { afterEach, describe, expect, it } from 'vitest';
import * as d from '../../src/db/index.js';
import { computeShares, amountsToRecord } from '../../src/core/index.js';
import { runTool, registry, confirmProposal, type ToolContext } from '../../src/agent/index.js';
import { fixture, expense, expenseArgs, fingerprint, prepare, turn, now, type Fixture } from './helpers.js';

const opened:Fixture[]=[];
const make=()=>{const f=fixture();opened.push(f);return f;};
afterEach(()=>{for(const f of opened.splice(0))f.db.close();});
const details='"Taxi" · 12.00 SGD\nPaid by "Sam" · 2026-09-28 · even split\n"Sam": 6.00 SGD; "Alex": 6.00 SGD';
const cases:Array<{name:string;args:(f:Fixture)=>unknown;summary:(f:Fixture)=>string;verify:(f:Fixture)=>void;notice?:string}>=[
 {name:'add_expense',args:()=>expenseArgs,summary:()=>`Add expense\n${details}`,notice:'expenseSaved',verify:f=>expect(d.listExpenses(f.db,f.scope,f.trip.id)).toHaveLength(1)},
 {name:'edit_expense',args:f=>({expenseId:expense(f).id,changes:{description:'Bus'}}),summary:()=>`Edit expense #1\n${details.replace('Taxi','Bus')}`,notice:'expenseEdited',verify:f=>expect(d.getExpense(f.db,f.scope,1).description).toBe('Bus')},
 {name:'approve_draft',args:f=>({expenseId:expense(f,'draft',{receiptFileId:'receipt'}).id}),summary:()=>`Approve draft #1\n${details}`,notice:'expenseSaved',verify:f=>expect(d.getExpense(f.db,f.scope,1)).toMatchObject({status:'confirmed',receiptFileId:'receipt'})},
 {name:'discard_draft',args:f=>({expenseId:expense(f,'draft').id}),summary:()=>`Discard draft #1\n${details}`,verify:f=>expect(d.getExpense(f.db,f.scope,1).status).toBe('discarded')},
 {name:'delete_expense',args:f=>({expenseId:expense(f).id}),summary:()=>`Delete expense #1\n${details}\nWarning: deleting this expense removes it from balances. It can be restored.`,notice:'expenseDeleted',verify:f=>expect(d.getExpense(f.db,f.scope,1).status).toBe('deleted')},
 {name:'restore_expense',args:f=>{const e=expense(f);d.deleteExpense(f.db,f.scope,e.id,e.version);return {expenseId:e.id};},summary:()=>`Restore expense #1\n${details}`,notice:'expenseRestored',verify:f=>expect(d.getExpense(f.db,f.scope,1).status).toBe('confirmed')},
 {name:'record_payment',args:()=>({from:'me',to:'Alex',amount:'12',currency:'SGD'}),summary:()=>`Record payment: "Sam" paid "Alex" 12.00 SGD.`,notice:'settlementRecorded',verify:f=>expect(d.listSettlements(f.db,f.scope,f.trip.id)[0]).toMatchObject({amount:1200,createdBy:f.member.id})},
 {name:'undo_payment',args:f=>({settlementId:d.createSettlement(f.db,f.scope,{tripId:f.trip.id,fromMemberId:f.member.id,toMemberId:f.alex.id,amount:1200}).id}),summary:()=>`Undo payment #1: "Sam" paid "Alex" 12.00 SGD.`,notice:'settlementUndone',verify:f=>expect(d.getSettlement(f.db,f.scope,1).status).toBe('undone')},
 {name:'add_member',args:()=>({name:'Lee'}),summary:()=>`Add member: "Lee". They will be included in future everyone splits.`,verify:f=>expect(d.listMembers(f.db,f.scope).map(m=>m.displayName)).toContain('Lee')},
 {name:'set_trip_rate',args:()=>({currency:'JPY',rate:'100'}),summary:()=>`Set trip rate: 1 SGD = 100 JPY (member).\nWarning: changing the trip rate will update 0 expenses (0 confirmed).`,notice:'tripRateChanged',verify:f=>expect(d.listTripRates(f.db,f.scope,f.trip.id)[0]).toMatchObject({currency:'JPY',rate:'100',origin:'member'})},
 {name:'set_expense_rate',args:f=>({expenseId:expense(f,'confirmed',{currency:'JPY',total:1200,rateOverride:'100'}).id,rate:'120'}),summary:()=>`Change expense rate #1\n"Taxi" · 1200 JPY\nPaid by "Sam" · 2026-09-28 · even split\n"Sam": 600 JPY; "Alex": 600 JPY\nHome total: 10.00 SGD · 1 SGD = 120 JPY (expense)\n"Sam": 5.00 SGD; "Alex": 5.00 SGD`,notice:'expenseEdited',verify:f=>expect(d.getExpense(f.db,f.scope,1)).toMatchObject({fxRate:'120',fxRateSource:'expense'})},
 {name:'rename_trip',args:()=>({name:'Japan'}),summary:()=>`Rename trip "Holiday" to "Japan".`,verify:f=>expect(d.getTrip(f.db,f.scope,f.trip.id).name).toBe('Japan')},
 {name:'end_trip',args:()=>({}),summary:()=>`End trip "Holiday".\nWarning: ending the trip stops expense and rate changes until it is reopened. Payments can still be recorded.`,notice:'tripEnded',verify:f=>expect(d.getTrip(f.db,f.scope,f.trip.id).status).toBe('ended')},
 {name:'reopen_trip',args:f=>{d.endTrip(f.db,f.scope,f.trip.id);return {};},summary:()=>`Reopen trip "Holiday". Expenses and rates can be changed again.`,notice:'tripReopened',verify:f=>expect(d.getTrip(f.db,f.scope,f.trip.id).status).toBe('active')},
];
describe('every changing tool',()=>{
 for(const c of cases)it(`${c.name}: exact summary, all-table fingerprint, actor, notice once`,async()=>{
  const f=make(),args=c.args(f);
  const {p,before,after}=await prepare(f,c.name,args);
  expect(after).toBe(before);
  expect(p.summary).toBe(c.summary(f));
  const result=confirmProposal(f.db,{}, {proposalId:p.id,memberId:f.member.id,now});
  expect(result.kind).toBe('done');
  if(result.kind==='done')expect(result.notices.map(n=>n.method)).toEqual(c.notice?[c.notice]:[]);
  c.verify(f);
  expect(d.listActivity(f.db,f.scope,{limit:1})[0]!.actor).toEqual(f.scope.actor);
  expect(confirmProposal(f.db,{}, {proposalId:p.id,memberId:f.member.id,now})).toEqual({kind:'already_done',text:'Already done.'});
 });
 for(const c of cases)it(`${c.name}: scripted model returns a proposal without changing foundation data`,async()=>{
  const f=make(),args=c.args(f),before=fingerprint(f.db,true);
  const {result,model}=await turn(f,c.name,args);
  expect(result.kind).toBe('proposal');expect(fingerprint(f.db,true)).toBe(before);
  expect(model.requests).toHaveLength(2);
  if(result.kind==='proposal') {
   expect(result.summary).toBe(c.summary(f));
   expect(confirmProposal(f.db,{}, {proposalId:result.proposalId,memberId:f.member.id,now}).kind).toBe('done');
   c.verify(f);
  }
 });
 it('contains exactly the 23 PRD tools' ,()=>expect(registry.map(t=>t.name).sort()).toEqual([...cases.map(c=>c.name),'get_trip','list_members','list_expenses','get_expense','get_balances','list_settlements','get_activity','resolve_members','preview_expense'].sort()));
});
describe('reading tools',()=>{
 it('returns foundation data, group scoped, without changing any table',async()=>{
  const f=make(),e=expense(f);
  const settlement=d.createSettlement(f.db,f.scope,{tripId:f.trip.id,fromMemberId:f.alex.id,toMemberId:f.member.id,amount:100});
  const before=fingerprint(f.db);
  const data=async(name:string,args:unknown={})=>{const r=await runTool(f.context,name,args);expect(r.kind).toBe('read');return r.kind==='read'?r.data:undefined;};
  expect(await data('get_trip')).toEqual({trip:d.getTrip(f.db,f.scope,f.trip.id),rates:[],members:d.listMembers(f.db,f.scope)});
  expect(await data('list_members')).toEqual(d.listMembers(f.db,f.scope));
  expect(await data('list_expenses')).toEqual([e]);
  expect(await data('get_expense',{expenseId:e.id})).toEqual({expense:e,problems:[],amounts:amountsToRecord(computeShares(e,e.items,e.shares))});
  expect(await data('get_balances')).toMatchObject({...d.getTripBalances(f.db,f.scope,f.trip.id),payments:expect.any(Array)});
  expect(await data('list_settlements')).toEqual([settlement]);
  expect(await data('get_activity',{expenseId:e.id})).toEqual(d.listActivity(f.db,f.scope,{entity:{type:'expense',id:e.id},limit:20}));
  expect(await data('resolve_members',{names:['me']})).toMatchObject([{status:'exact',members:[{id:f.member.id}]}]);
  expect(await data('preview_expense',expenseArgs)).toMatchObject({summary:details,preview:{amounts:{[f.member.id]:600,[f.alex.id]:600}}});
  expect(fingerprint(f.db)).toBe(before);
 });
 it('filters status, date, payer and text, with at most 20 newest first',async()=>{
  const f=make();for(let i=1;i<=25;i++)expense(f,'confirmed',{expenseDate:`2026-09-${String(i).padStart(2,'0')}`,description:`Taxi ${i}`});
  const r=await runTool(f.context,'list_expenses',{});expect(r.kind==='read'&&(r.data as d.ExpenseDetail[]).length).toBe(20);
  const filtered=await runTool(f.context,'list_expenses',{from:'2026-09-10',to:'2026-09-20',payer:'Sam',text:'taxi 1',status:'confirmed'});
  expect(filtered.kind==='read'&&(filtered.data as d.ExpenseDetail[]).map(e=>e.expenseDate)).toEqual(Array.from({length:10},(_,i)=>`2026-09-${19-i}`));
 });
 it('refuses foreign group expense, settlement, trip and activity IDs',async()=>{
  const f=make();const scope=d.memberScope(f.other.group.id,f.other.members[0]!.id);
  const e=d.createExpense(f.db,scope,{tripId:f.other.trip!.id,payerId:f.other.members[0]!.id,expenseDate:'2026-09-28',total:100,splitType:'even',shares:[{memberId:f.other.members[0]!.id}]});
  const s=d.createSettlement(f.db,scope,{tripId:f.other.trip!.id,fromMemberId:f.other.members[0]!.id,toMemberId:f.other.members[1]!.id,amount:100});
  for(const [tool,args] of [['get_expense',{expenseId:e.id}],['edit_expense',{expenseId:e.id,changes:{amount:'1'}}],['get_activity',{expenseId:e.id}],['get_balances',{tripId:f.other.trip!.id}],['undo_payment',{settlementId:s.id}]] as const)
   await expect(runTool(f.context,tool,args)).rejects.toBeInstanceOf(d.NotFoundError);
 });
 it('keeps invalid drafts readable without computing invalid shares',async()=>{
  const f=make(),e=expense(f,'draft',{total:0,shares:[]});
  expect(await runTool(f.context,'get_expense',{expenseId:e.id})).toMatchObject({kind:'read',data:{amounts:null,problems:expect.any(Array)}});
 });
});
describe('name resolution and validation',()=>{
 it('resolves exact names, username, me, I and active everyone; ambiguous/unknown returns candidates',async()=>{
  const f=make();d.addManualMember(f.db,f.scope,'Alex');const inactive=d.addManualMember(f.db,f.scope,'Inactive');d.setMemberActive(f.db,f.scope,inactive.id,false);
  const r=await runTool(f.context,'resolve_members',{names:['Sam','sam','me','I','everyone','Alex','Nobody','Sa']});
  expect(r.kind).toBe('read');if(r.kind!=='read')return;
  const found=r.data as Array<{status:string;members?:d.Member[];candidates?:d.Member[]}>;
  expect(found.map(x=>x.status)).toEqual(['exact','exact','exact','exact','exact','ambiguous','unknown','unknown']);
  expect(found[4]!.members?.map(m=>m.displayName).sort()).toEqual(['Alex','Alex','Sam']);
  expect(found[5]!.candidates).toHaveLength(2);
  await expect(runTool(f.context,'add_expense',{...expenseArgs,payer:'Alex'})).rejects.toThrow('Which person');
 });
 it('rejects unknown fields including groupId, status draft, numeric money and invalid dates',async()=>{
  const f=make(),before=fingerprint(f.db);
  for(const bad of [{groupId:f.other.group.id},{status:'draft'},{amount:12},{date:'2026-02-30'},{currency:'XYZ'},{amount:'1.001'},{people:[{name:'Nobody'}]}])
   await expect(runTool(f.context,'add_expense',{...expenseArgs,...bad})).rejects.toThrow();
  expect(fingerprint(f.db)).toBe(before);
 });
 it('preserves all expense fields and item assignments on partial edits',async()=>{
  const f=make();const e=expense(f,'confirmed',{description:'Dinner',merchant:'Cafe',total:1300,tax:100,taxIncluded:false,tip:100,serviceCharge:200,discount:100,splitType:'items',receiptFileId:'file',items:[{label:'Food',amount:1000,quantity:2,shares:[{memberId:f.alex.id}]}]});
  const {p}=await prepare(f,'edit_expense',{expenseId:e.id,changes:{description:'Lunch'}});
  expect(confirmProposal(f.db,{}, {proposalId:p.id,memberId:f.member.id,now}).kind).toBe('done');
  const after=d.getExpense(f.db,f.scope,e.id);
  for(const field of ['merchant','total','tax','taxIncluded','tip','serviceCharge','discount','splitType','receiptFileId','currency','payerId','expenseDate'] as const)expect(after[field]).toEqual(e[field]);
  expect(after.items[0]).toMatchObject({label:'Food',quantity:2,amount:1000});
  expect(after.shares.filter(s=>s.itemId!==null).map(s=>s.memberId)).toEqual([f.alex.id]);
 });
 it('uses foundation portions and by-item validation and rounding',async()=>{
  const f=make();const r=await runTool(f.context,'preview_expense',{...expenseArgs,amount:'10.01',splitType:'portions',people:[{name:'Sam',weight:2},{name:'Alex',weight:1}]});
  expect(r).toMatchObject({kind:'read',data:{preview:{amounts:{[f.member.id]:668,[f.alex.id]:333}}}});
  await expect(runTool(f.context,'add_expense',{...expenseArgs,splitType:'items',items:[{label:'Food',amount:'1'}]})).rejects.toThrow('total');
 });
});

it('validates item assignment membership even when items are kept on an even split',async()=>{
 const f=make();
 await expect(runTool(f.context,'add_expense',{...expenseArgs,people:[{name:'Sam'}],items:[{label:'Unassigned',amount:'12',people:[{name:'Alex'}]}]})).rejects.toThrow('included');
});
it('a different member acts under their own foundation scope',async()=>{
 const f=make();const context={...f.context,scope:d.memberScope(f.g.group.id,f.alex.id)};
 const result=await runTool(context,'add_expense',{...expenseArgs,payer:'me'});
 expect(result.kind).toBe('proposal');if(result.kind!=='proposal')return;
 expect(result.plans[0]!.action).toMatchObject({input:{payerId:f.alex.id}});
 expect(result.plans[0]!.summary).toContain('Paid by "Alex"');
});

it('edits an existing incomplete receipt draft without confirming it or losing its review flag',async()=>{
 const f=make();const e=expense(f,'draft',{total:0,shares:[],receiptFileId:'receipt',currencyNeedsReview:true});
 const {p,before,after}=await prepare(f,'edit_expense',{expenseId:e.id,changes:{description:'Receipt lunch'}});
 expect(after).toBe(before);expect(p.summary).toContain('Draft remains unconfirmed');
 expect(confirmProposal(f.db,{}, {proposalId:p.id,memberId:f.member.id,now})).toEqual({kind:'done',notices:[]});
 expect(d.getExpense(f.db,f.scope,e.id)).toMatchObject({status:'draft',currencyNeedsReview:true,receiptFileId:'receipt',description:'Receipt lunch'});
});
it('only explicit currency confirmation clears a receipt review flag',async()=>{
 const f=make();const e=expense(f,'draft',{currencyNeedsReview:true});
 await expect(runTool(f.context,'approve_draft',{expenseId:e.id})).rejects.toThrow('currency');
 const {p}=await prepare(f,'approve_draft',{expenseId:e.id,changes:{currency:'SGD'}});
 expect(confirmProposal(f.db,{}, {proposalId:p.id,memberId:f.member.id,now}).kind).toBe('done');
 expect(d.getExpense(f.db,f.scope,e.id)).toMatchObject({status:'confirmed',currencyNeedsReview:false});
});
