import { z } from 'zod';
import { defineTool, name, plan } from './shared.js';
export default defineTool('add_member','Add a hand-added member by name.',z.strictObject({name}),(c,a)=>plan({kind:'add_member',name:a.name},`Add member: ${JSON.stringify(a.name)}. They will be included in future everyone splits.`,'Add member'));
