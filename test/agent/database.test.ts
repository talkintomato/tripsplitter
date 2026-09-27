import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as d from '../../src/db/index.js';
import { runAgentTurn } from '../../src/agent/index.js';
import { ScriptedAgentModel, text } from './fakeModel.js';
import { fixture, now, type Fixture } from './helpers.js';
const opened:Fixture[]=[];const make=()=>{const f=fixture();opened.push(f);return f;};
afterEach(()=>opened.splice(0).forEach(f=>f.db.close()));

it('migration 002 adds exactly three tables and preserves existing rows; reruns do nothing',()=>{
 const f=make();expect(f.db.prepare('SELECT id,name FROM migration WHERE id <= 2 ORDER BY id').all()).toEqual([{id:1,name:'001_init.sql'},{id:2,name:'002_agent.sql'}]);
 expect(d.migrate(f.db)).toEqual([]);
 expect(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_%' ORDER BY name").all()).toEqual([{name:'agent_proposal'},{name:'agent_turn'},{name:'agent_usage'}]);
 const old=d.openDatabase(':memory:',{migrate:false});
 try {
  old.exec('CREATE TABLE migration(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL)');
  old.exec(readFileSync(new URL('../../src/db/migrations/001_init.sql',import.meta.url),'utf8'));
  old.prepare('INSERT INTO migration VALUES(1,?,?)').run('001_init.sql',now.toISOString());
  old.prepare('INSERT INTO chat_group(chat_id,title,created_at) VALUES(?,?,?)').run(-123,'Kept',now.toISOString());
  expect(d.migrate(old)).toContain('002_agent.sql');
  expect(old.prepare('SELECT title FROM chat_group').get()).toEqual({title:'Kept'});
 } finally {old.close();}
});
it('turns are isolated per member and chat, capped at 8 and expire by last activity',()=>{
 const f=make();const scope2=d.memberScope(f.g.group.id,f.alex.id);
 for(let i=0;i<12;i++)d.appendTurn(f.db,f.scope,-100,i%2?'assistant':'user',`turn ${i}`,new Date(now.getTime()+i*60_000));
 d.appendTurn(f.db,f.scope,1,'user','private',now);
 d.appendTurn(f.db,scope2,-100,'user','another person',now);
 const latest=new Date(now.getTime()+11*60_000);
 expect(d.recentTurns(f.db,f.scope,-100,latest).map(t=>t.content)).toEqual(Array.from({length:8},(_,i)=>`turn ${i+4}`));
 expect(d.recentTurns(f.db,f.scope,1,latest).map(t=>t.content)).toEqual(['private']);
 expect(d.recentTurns(f.db,scope2,-100,latest).map(t=>t.content)).toEqual(['another person']);
 expect(d.recentTurns(f.db,f.scope,-100,new Date(now.getTime()+40*60_000))).toHaveLength(8);
 expect(d.recentTurns(f.db,f.scope,-100,new Date(now.getTime()+41*60_000))).toEqual([]);
 expect(f.db.prepare('SELECT * FROM agent_turn').all()).toEqual([]);
});
it('the loop sees history only for the same member/chat, storing neither turns nor model failures in activity',async()=>{
 const f=make();const before=d.listActivity(f.db,f.scope);
 d.appendTurn(f.db,f.scope,-100,'user','prior private user text',now);
 d.appendTurn(f.db,f.scope,-100,'assistant','prior response',now);
 d.appendTurn(f.db,d.memberScope(f.g.group.id,f.alex.id),-100,'user','other person secret',now);
 const model=new ScriptedAgentModel([text('Here to help.')]);
 await runAgentTurn(f.db,f.config,{model,suggestRate:async()=>null},{groupId:f.g.group.id,memberId:f.member.id,chatId:-100,text:'my private turn',now});
 expect(model.requests[0]!.conversation.map(t=>t.content)).toEqual(['prior private user text','prior response']);
 expect(d.listActivity(f.db,f.scope)).toEqual(before);
 expect(JSON.stringify(d.listActivity(f.db,f.scope))).not.toContain('private');
});
it('private group choices follow authenticated Telegram identity and survive conversation expiry',()=>{
 const f=make();
 expect(d.chosenGroup(f.db,999,1)).toBeUndefined();
 expect(d.chosenGroup(f.db,1,1)).toBeUndefined();
 d.rememberChosenGroup(f.db,f.scope,1,now);
 expect(d.chosenGroup(f.db,1,1)).toEqual({groupId:f.g.group.id,memberId:f.member.id});
 expect(d.chosenGroup(f.db,2,1)).toBeUndefined();
 d.rememberChosenGroup(f.db,d.memberScope(f.other.group.id,f.other.members[0]!.id),1,now);
 expect(d.chosenGroup(f.db,1,1)).toEqual({groupId:f.other.group.id,memberId:f.other.members[0]!.id});
 expect(d.recentTurns(f.db,f.scope,1,now)).toEqual([]);
 d.forgetExpiredTurns(f.db,new Date(now.getTime()+60*60_000));
 expect(d.chosenGroup(f.db,1,1)?.groupId).toBe(f.other.group.id);
 const manual=d.addManualMember(f.db,f.scope,'Manual');
 expect(()=>d.rememberChosenGroup(f.db,d.memberScope(f.g.group.id,manual.id),1,now)).toThrow(d.PermissionError);
 expect(()=>d.rememberChosenGroup(f.db,d.memberScope(f.other.group.id,f.member.id),1,now)).toThrow(d.PermissionError);
});
it('usage is counted atomically by Singapore day, with independent group and global caps',()=>{
 const f=make(),before=new Date('2026-09-28T15:59:59.999Z'),after=new Date('2026-09-28T16:00:00Z');
 expect(d.reserveAgentMessage(f.db,f.g.group.id,1,before,2)).toBe(true);
 expect(d.reserveAgentMessage(f.db,f.g.group.id,1,before,2)).toBe(false);
 expect(d.reserveAgentMessage(f.db,f.other.group.id,10,before,2)).toBe(true);
 expect(d.reserveAgentMessage(f.db,f.other.group.id,10,before,2)).toBe(false);
 expect(d.reserveAgentMessage(f.db,f.g.group.id,1,after,2)).toBe(true);
 expect(d.reserveAgentMessage(f.db,f.other.group.id,0,after,0)).toBe(false);
 expect(d.reserveAgentMessage(f.db,f.other.group.id,10,before,0)).toBe(true);
 const rows=f.db.prepare('SELECT day,created_at FROM agent_usage ORDER BY id').all();
 expect(rows).toEqual([{day:'2026-09-28',created_at:before.toISOString()},{day:'2026-09-28',created_at:before.toISOString()},{day:'2026-09-29',created_at:after.toISOString()},{day:'2026-09-28',created_at:before.toISOString()}]);
});
it('invalid reservations and foreign scopes cannot write agent state',()=>{
 const f=make();
 for(const cap of [-1,0.5,Infinity,Number.MAX_SAFE_INTEGER+1])expect(()=>d.reserveAgentMessage(f.db,f.g.group.id,cap,now)).toThrow(d.ValidationError);
 expect(()=>d.reserveAgentMessage(f.db,999,1,now)).toThrow(d.NotFoundError);
 expect(()=>d.reserveAgentMessage(f.db,f.g.group.id,1,new Date('invalid'))).toThrow(d.ValidationError);
 expect(()=>d.appendTurn(f.db,d.memberScope(f.other.group.id,f.member.id),1,'user','secret',now)).toThrow(d.PermissionError);
 expect(f.db.prepare('SELECT * FROM agent_turn').all()).toEqual([]);
});
it('proposal IDs are random; versions and actions round-trip; finish is scoped and compare-and-set',()=>{
 const f=make();
 const p=d.createProposal(f.db,f.scope,{chatId:-100,actions:[{data:1}],summary:'A summary',versions:{revision:1},now});
 expect(p.id).toMatch(/^[a-f0-9-]{36}$/);expect(d.getProposal(f.db,p.id)).toEqual(p);
 expect(p.expiresAt).toBe(new Date(now.getTime()+15*60_000).toISOString());
 expect(d.finishProposal(f.db,d.memberScope(f.g.group.id,f.alex.id),p.id,'done')).toBe(false);
 expect(d.finishProposal(f.db,f.scope,p.id,'done')).toBe(true);
 expect(d.finishProposal(f.db,f.scope,p.id,'cancelled')).toBe(false);
});

it('switching private groups keeps at most eight turns for the Telegram person without leaking group history',()=>{
 const f=make(),otherScope=d.memberScope(f.other.group.id,f.other.members[0]!.id);
 for(let i=0;i<8;i++)d.appendTurn(f.db,f.scope,1,'user',`first group ${i}`,now);
 for(let i=0;i<8;i++)d.appendTurn(f.db,otherScope,1,'user',`other group ${i}`,now);
 expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_turn WHERE role <> 'chosen_group'").get()).toEqual({n:8});
 expect(d.recentTurns(f.db,f.scope,1,now)).toEqual([]);
 expect(d.recentTurns(f.db,otherScope,1,now)).toHaveLength(8);
 const first=d.createProposal(f.db,f.scope,{chatId:1,actions:[],summary:'First',versions:{},now});
 d.createProposal(f.db,otherScope,{chatId:1,actions:[],summary:'Second',versions:{},now});
 expect(d.getProposal(f.db,first.id)?.status).toBe('cancelled');
});
