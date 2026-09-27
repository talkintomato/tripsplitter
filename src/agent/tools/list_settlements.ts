import { z } from 'zod';
import { defineTool, id, read, trip } from './shared.js';
import { listSettlements } from '../../db/index.js';
export default defineTool('list_settlements','Recorded payments, active and undone unless filtered.',z.strictObject({tripId:id.optional(),status:z.enum(['active','undone']).optional()}),(c,a)=>read(listSettlements(c.db,c.scope,trip(c,a.tripId).id,{status:a.status})));
