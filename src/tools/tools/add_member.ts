import { z } from 'zod';
import { defineTool, name, plan } from './shared.js';
export default defineTool('add_member','Add a hand-added member by name.',z.strictObject({name}),(c,a)=>plan({kind:'add_member',name:a.name},{icon:'👤',title:`Add person ${a.name}`,blocks:[{lines:['They will be included in future everyone splits.']}]},'Add member'));
