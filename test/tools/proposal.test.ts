import { afterEach, expect, it } from 'vitest';
import * as d from '../../src/db/index.js';
import { confirmProposal, cancelProposal } from '../../src/tools/index.js';
import { fixture, expense, fingerprint, prepare, now, type Fixture } from '../agent/helpers.js';
const opened:Fixture[]=[];const make=()=>{const f=fixture();opened.push(f);return f;};
afterEach(()=>opened.splice(0).forEach(f=>f.db.close()));

it('only the owner can confirm or cancel, even after expiry or completion',async()=>{
 const f=make();const {p}=await prepare(f,'add_member',{name:'Lee'});
 const before=fingerprint(f.db);
 for(const decide of [confirmProposal,cancelProposal])expect(decide(f.db,{}, {proposalId:p.id,memberId:f.alex.id,now}).kind).toBe('not_yours');
 expect(fingerprint(f.db)).toBe(before);
 expect(cancelProposal(f.db,{}, {proposalId:p.id,memberId:f.member.id,now})).toEqual({kind:'done',notices:[]});
 expect(confirmProposal(f.db,{}, {proposalId:p.id,memberId:f.member.id,now})).toEqual({kind:'refused',reason:'That offer was cancelled.'});
});
it('expires at exactly 15 minutes and refuses stale records, membership, trip and rate changes',async()=>{
 const f=make();let {p}=await prepare(f,'add_member',{name:'Lee'});
 const expired=new Date(now.getTime()+15*60_000);
 expect(confirmProposal(f.db,{}, {proposalId:p.id,memberId:f.member.id,now:expired})).toEqual({kind:'expired',text:'That offer expired. Ask me again.'});
 expect(d.getProposal(f.db,p.id)!.status).toBe('expired');
 const e=expense(f);
 for(const change of [()=>d.saveExpense(f.db,f.scope,e.id,d.getExpense(f.db,f.scope,e.id).version,{payerId:f.member.id,total:1400,expenseDate:'2026-09-28',splitType:'even',shares:[{memberId:f.member.id}]}),()=>d.addManualMember(f.db,f.scope,'New'),()=>d.renameTrip(f.db,f.scope,f.trip.id,'Changed'),()=>d.setTripRate(f.db,f.scope,f.trip.id,'JPY','100','member')]) {
  ({p}=await prepare(f,'delete_expense',{expenseId:e.id}));change();const before=fingerprint(f.db);
  expect(confirmProposal(f.db,{}, {proposalId:p.id,memberId:f.member.id,now})).toEqual({kind:'changed',text:'This changed since I prepared it. Ask me again.'});expect(fingerprint(f.db)).toBe(before);
 }
});
it('another group changing does not invalidate the proposal',async()=>{
 const f=make();const {p}=await prepare(f,'add_member',{name:'Lee'});
 d.renameTrip(f.db,d.memberScope(f.other.group.id,f.other.members[0]!.id),f.other.trip!.id,'Elsewhere');
 expect(confirmProposal(f.db,{}, {proposalId:p.id,memberId:f.member.id,now}).kind).toBe('done');
});
