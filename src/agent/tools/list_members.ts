import { z } from 'zod';
import { defineTool, read } from './shared.js';
import { listMembers } from '../../db/index.js';
export default defineTool('list_members','All unmerged members, with active and joinedVia fields.',z.strictObject({}),(c)=>read(listMembers(c.db,c.scope)));
