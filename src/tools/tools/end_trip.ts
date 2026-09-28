import { z } from 'zod';
import { defineTool, id, name, rate, read, plan, trip, openTrip } from './shared.js';
export default defineTool('end_trip','End a trip; expenses and rates become read-only.',z.strictObject({tripId:id.optional()}),(c,a)=>{const t=trip(c,a.tripId);openTrip(t);return plan({kind:'end_trip',tripId:t.id},{icon:'🏁',title:`End trip ${t.name}`,blocks:[{lines:['⚠️ Expenses and rates cannot be changed until the trip is reopened.', 'Payments can still be recorded.']}]},'End trip');});
