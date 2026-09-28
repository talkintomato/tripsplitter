import { z } from 'zod';
import { defineTool, id, currency, rate, trip } from './shared.js';
import { ratePlan } from './expensePlan.js';
export default defineTool('set_trip_rate','Preview a trip rate change and propose it, including affected expenses.',z.strictObject({tripId:id.optional(),currency,rate}),(c,a)=>({kind:'proposal',plans:[ratePlan(c,trip(c,a.tripId).id,a.currency,a.rate,'member')]}));
