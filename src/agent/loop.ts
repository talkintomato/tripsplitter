import { ZodError } from 'zod';
import { memberScope, getMember, DomainError, singaporeDate, appendTurn, recentTurns, reserveAgentMessage, type Db } from '../db/index.js';
import type { Config } from '../config.js';
import { AGENT_INSTRUCTION } from './prompt.js';
import { asData, type AgentModelInput, type ToolResult } from './model.js';
import { runTool, toolDefinitions } from './registry.js';
import { createAgentProposal, proposalVersions } from './proposal.js';
import type { AgentDeps, PlannedAction, ToolContext } from './types.js';

export interface AgentTurnInput { groupId:number;memberId:number;chatId:number;text:string;now:Date }
export type AgentTurnResult = {kind:'reply';text:string}|{kind:'proposal';proposalId:string;summary:string;confirmLabel:string}|{kind:'limit'}|{kind:'unavailable'};
export const TOOL_CALL_LIMIT=6;
function safeError(error:unknown):string {
  if(error instanceof ZodError)return 'Some arguments are missing or invalid. Check the tool schema and ask one short question.';
  if(error instanceof DomainError||error instanceof RangeError)return error.message;
  return 'That request could not be prepared.';
}
/** No logging, no provider calls except the injected model and rate suggester. */
export async function runAgentTurn(db:Db,config:Config,deps:AgentDeps,input:AgentTurnInput):Promise<AgentTurnResult> {
  if(!config.agentEnabled)return {kind:'unavailable'};
  const scope=memberScope(input.groupId,input.memberId);
  const context:ToolContext={db,scope,suggestRate:deps.suggestRate,now:input.now};
  try {
    const member=getMember(db,scope,input.memberId);
    if(member.mergedInto!==null)return {kind:'unavailable'};
    if(!reserveAgentMessage(db,input.groupId,config.agentDailyCap,input.now,config.agentGlobalDailyCap))return {kind:'limit'};
    const conversation=recentTurns(db,scope,input.chatId,input.now);
    const versions=proposalVersions(db,scope);
    const facts=await runTool(context,'get_trip',{});
    const request:AgentModelInput={instruction:AGENT_INSTRUCTION,conversation,trip:asData(facts.kind==='read'?facts.data:null),
      tools:structuredClone(toolDefinitions),message:input.text,today:singaporeDate(input.now),steps:[],remainingToolCalls:TOOL_CALL_LIMIT};
    const plans:PlannedAction[]=[];
    let failure:string|undefined;
    let reply='I reached the tool limit. Please ask me to continue.';
    while(request.remainingToolCalls>0) {
      const response=await deps.model.respond(structuredClone(request));
      if(response.kind==='text') {reply=response.text;break;}
      if(response.kind!=='tool_calls'||!Array.isArray(response.calls)||response.calls.length===0)return {kind:'unavailable'};
      // Reject an oversized batch in full: never silently propose a partial batch of changes.
      if(response.calls.length>request.remainingToolCalls) {failure='I reached the tool limit. Please ask for fewer changes at once.';break;}
      const results:ToolResult[]=[];
      for(const call of response.calls) {
        request.remainingToolCalls--;
        try {
          const result=await runTool(context,call.name,call.arguments);
          if(result.kind==='proposal')plans.push(...result.plans);
          results.push({callId:call.id,name:call.name,result:asData(result.kind==='read'?result.data:{proposal:true,summary:result.plans.map(p=>p.summary).join('\n\n')})});
        } catch(error) {
          failure=safeError(error);
          results.push({callId:call.id,name:call.name,result:asData({refused:true,reason:failure})});
        }
      }
      request.steps.push({calls:response.calls,results});
    }
    let result:AgentTurnResult;
    if(failure)result={kind:'reply',text:failure};
    else if(plans.length) {
      try {
        const proposal=createAgentProposal(db,scope,{chatId:input.chatId,plans,versions,now:input.now});
        const label=plans.length===1?plans[0]!.confirmLabel:
          plans.some(p=>p.action.kind==='delete_expense')?'Delete and confirm':
          plans.some(p=>p.action.kind==='end_trip')?'End trip and confirm':
          plans.some(p=>p.action.kind==='set_trip_rate'&&p.action.origin==='member')?'Set rate and confirm':
          plans.every(p=>p.action.kind==='add_expense'||(p.action.kind==='set_trip_rate'&&p.action.origin==='suggested'))?'Add it':'Confirm changes';
        result={kind:'proposal',proposalId:proposal.id,summary:proposal.summary,confirmLabel:label};
      } catch(error) {result={kind:'reply',text:safeError(error)};}
    } else result={kind:'reply',text:reply};
    appendTurn(db,scope,input.chatId,'user',input.text,input.now);
    appendTurn(db,scope,input.chatId,'assistant',result.kind==='proposal'?result.summary:result.text,input.now);
    return result;
  } catch { return {kind:'unavailable'}; }
}
