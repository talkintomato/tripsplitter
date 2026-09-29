import type { Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv, Services } from '../context.js';
import { lookupPlace } from '../places.js';
import { readBody } from '../schemas.js';

const coordinates = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

export function registerPlaceRoutes(app: Hono<ApiEnv>, { config, db }: Services): void {
  app.post('/api/places/lookup', async c => {
    const { lat, lng } = await readBody(c, coordinates);
    return c.json({ name: await lookupPlace(db, config.placeLookup, lat, lng) });
  });
}
