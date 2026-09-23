import { Hono } from 'hono';
import { listSleepInterventionTracks } from '../services/sleepIntervention.js';
import { SLEEP_INTERVENTION_UPLOAD_HTML } from './sleepInterventionUploadPage.js';

export const sleepInterventionRoutes = new Hono();

sleepInterventionRoutes.get('/tracks', async (c) => {
  const tracks = await listSleepInterventionTracks(true);
  return c.json({ tracks });
});

sleepInterventionRoutes.get('/upload', (c) => c.html(SLEEP_INTERVENTION_UPLOAD_HTML));
