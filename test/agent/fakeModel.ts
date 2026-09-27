import type { AgentModel, AgentModelInput, AgentModelOutput, ToolCall } from '../../src/agent/index.js';
export type ScriptStep=AgentModelOutput|Error|((input:AgentModelInput)=>AgentModelOutput|Promise<AgentModelOutput>);
export class ScriptedAgentModel implements AgentModel {
  readonly requests:AgentModelInput[]=[];
  constructor(private readonly script:ScriptStep[]){}
  async respond(input:AgentModelInput):Promise<AgentModelOutput>{
    this.requests.push(structuredClone(input));
    const step=this.script.shift();
    if(!step)throw new Error('Script exhausted');
    if(step instanceof Error)throw step;
    return typeof step==='function'?step(input):step;
  }
}
export const calls=(...entries:Array<[string,unknown]>):AgentModelOutput=>({kind:'tool_calls',calls:entries.map(([name,args],index):ToolCall=>({id:`call-${index}`,name,arguments:args}))});
export const text=(text='Ready.'):AgentModelOutput=>({kind:'text',text});
