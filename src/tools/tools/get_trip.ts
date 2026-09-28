import { z } from 'zod';
import { defineTool, id, read, trip } from './shared.js';
import { getActiveTrip, getOrCreateActiveTrip, listTrips, listTripRates, listMembers } from '../../db/index.js';
export default defineTool('get_trip','Trip facts, rates and member names. Omit tripId for the active or latest trip.',z.strictObject({tripId:id.optional()}),(c,a)=>{
 const t=a.tripId===undefined ? (c.startTripIfMissing ? getOrCreateActiveTrip(c.db,c.scope).trip : getActiveTrip(c.db,c.scope) ?? listTrips(c.db,c.scope)[0]) : trip(c,a.tripId);
 return read({trip:t??null,rates:t?listTripRates(c.db,c.scope,t.id):[],members:listMembers(c.db,c.scope)});
});
