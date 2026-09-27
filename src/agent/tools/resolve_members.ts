import { z } from 'zod';
import { defineTool, name, read, resolveNames } from './shared.js';
export default defineTool('resolve_members','Resolve exact names, me, I and everyone; ask when ambiguous or unknown.',z.strictObject({names:z.array(name).min(1).max(100)}),(c,a)=>read(resolveNames(c,a.names)));
