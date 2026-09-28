import * as d from '../../src/db/index.js';
import { buildConfig } from '../../src/config.js';
import { ScriptedAgentModel, calls, text } from './fakeModel.js';
import { runAgentTurn } from '../../src/agent/index.js';
import { runTool, createAgentProposal, proposalVersions, type ToolContext, type PlannedAction } from '../../src/tools/index.js';

export const now=new Date('2026-09-28T04:00:00Z');
export const expenseArgs={description:'Taxi',amount:'12.00',currency:'SGD',payer:'me',date:'2026-09-28',splitType:'even',people:[{name:'everyone'}]};
export function fixture(){
 const db=d.openDatabase(':memory:');
 const g=d.ensureGroup(db,-100,'Holiday',[{telegramUserId:1,displayName:'Sam'},{telegramUserId:2,displayName:'Alex'}]);
 const scope=d.memberScope(g.group.id,g.members[0]!.id);
 const context:ToolContext={db,scope,now,suggestRate:async()=>null};
 const other=d.ensureGroup(db,-200,'Other',[{telegramUserId:1,displayName:'Sam'},{telegramUserId:3,displayName:'Other'}]);
 return {db,scope,context,g,other,trip:g.trip!,member:g.members[0]!,alex:g.members[1]!,config:buildConfig({agentEnabled:true})};
}
export type Fixture=ReturnType<typeof fixture>;
export function expense(f:Fixture,status:'draft'|'confirmed'='confirmed',extra:Partial<d.CreateExpenseInput>={}) {
 return d.createExpense(f.db,f.scope,{tripId:f.trip.id,payerId:f.member.id,description:'Taxi',expenseDate:'2026-09-28',total:1200,currency:'SGD',splitType:'even',shares:[{memberId:f.member.id},{memberId:f.alex.id}],status,...extra});
}
/** Includes every table, sqlite_sequence, activity and agent state; schema names come only from sqlite. */
export function fingerprint(db:d.Db,excludeAgent=false):string {
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[];
 return JSON.stringify(tables.filter(t=>!excludeAgent||!t.name.startsWith('agent_')).map(t=>[t.name,db.prepare(`SELECT * FROM "${t.name.replaceAll('"','""')}"`).all()]));
}
export async function prepare(f:Fixture,name:string,args:unknown) {
 const versions=proposalVersions(f.db,f.scope);
 const before=fingerprint(f.db);
 const result=await runTool(f.context,name,args);
 if(result.kind!=='proposal')throw new Error('Expected proposal');
 const after=fingerprint(f.db);
 const p=createAgentProposal(f.db,f.scope,{chatId:-100,plans:result.plans,versions,now});
 return {p,before,after,plans:result.plans};
}
export async function turn(f:Fixture,name:string,args:unknown){
 const model=new ScriptedAgentModel([calls([name,args]),text('The model does not write the summary.')]);
 const result=await runAgentTurn(f.db,f.config,{model,suggestRate:f.context.suggestRate},{groupId:f.g.group.id,memberId:f.member.id,chatId:-100,text:'Do this',now});
 return {result,model};
}
