import { z } from 'zod';
import { defineTool, id, name, plan, trip, openTrip } from './shared.js';
export default defineTool('rename_trip','Rename the active trip.',z.strictObject({tripId:id.optional(),name:z.string().trim().min(1).max(200)}),(c,a)=>{const t=trip(c,a.tripId);openTrip(t);return plan({kind:'rename_trip',tripId:t.id,name:a.name},`Rename trip ${JSON.stringify(t.name)} to ${JSON.stringify(a.name)}.`,'Rename it');});
