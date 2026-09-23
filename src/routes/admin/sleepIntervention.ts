import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import {
  requireAdminAuth,
  requireAdminPermission,
  type AdminVariables,
} from '../../middleware/adminAuth.js';
import { writeAdminAuditLog } from '../../modules/admin/audit.js';
import {
  createSleepInterventionTrack,
  deleteSleepInterventionTrack,
  listSleepInterventionTracks,
  SleepInterventionError,
  updateSleepInterventionTrack,
} from '../../services/sleepIntervention.js';

export const adminSleepInterventionRoutes = new Hono<{ Variables: AdminVariables }>();

adminSleepInterventionRoutes.use('*', requireAdminAuth);

const AUDIO_MIME_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
};

const IMAGE_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const MAX_AUDIO_BYTES = 40 * 1024 * 1024;

function safeName(name: string) {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'audio';
}

function extFromName(name: string): string | null {
  const match = /\.(mp3|m4a|aac|wav)$/i.exec(name);
  return match ? match[1].toLowerCase() : null;
}

function readBool(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return fallback;
  return text === '1' || text === 'true' || text === 'on' || text === 'yes';
}

async function saveUpload(file: File, kind: 'audio' | 'images', ext: string) {
  const today = new Date().toISOString().slice(0, 10);
  const relativeDir = path.join('uploads', 'admin', kind, today);
  const absoluteDir = path.resolve(process.cwd(), relativeDir);
  await mkdir(absoluteDir, { recursive: true });
  const filename = `${Date.now()}-${safeName(file.name)}.${ext}`;
  const relativePath = path.join(relativeDir, filename).replace(/\\/g, '/');
  const bytes = Buffer.from(await file.arrayBuffer());
  await writeFile(path.resolve(process.cwd(), relativePath), bytes);
  return { url: `/${relativePath}`, size: bytes.byteLength };
}

function audioFile(form: FormData, required: boolean) {
  const file = form.get('file');
  if (!file || typeof file === 'string' || file.size <= 0) {
    if (required) return { error: '请选择音频文件' as const };
    return { file: null };
  }
  const ext = AUDIO_MIME_EXT[file.type] ?? extFromName(file.name);
  if (!ext) return { error: '仅支持 mp3、m4a、aac、wav' as const };
  if (file.size > MAX_AUDIO_BYTES) return { error: '音频不能超过 40MB' as const };
  return { file, ext };
}

async function coverUrlFromForm(form: FormData) {
  const cover = form.get('cover');
  if (!cover || typeof cover === 'string' || cover.size <= 0) return { url: undefined as string | undefined };
  const coverExt = IMAGE_MIME_EXT[cover.type];
  if (!coverExt) return { error: '封面仅支持 jpg、png、webp' as const };
  if (cover.size > 5 * 1024 * 1024) return { error: '封面不能超过 5MB' as const };
  return { url: (await saveUpload(cover, 'images', coverExt)).url };
}

function sendError(c: { json: (body: unknown, status?: number) => Response }, error: unknown) {
  if (error instanceof SleepInterventionError) {
    const status = error.code === 'not_found' ? 404 : 400;
    return c.json({ error: error.code, message: error.message }, status);
  }
  throw error;
}

adminSleepInterventionRoutes.get('/tracks', async (c) => {
  const tracks = await listSleepInterventionTracks(false);
  return c.json({ tracks });
});

adminSleepInterventionRoutes.post(
  '/tracks',
  requireAdminPermission('content:write'),
  async (c) => {
    const auth = c.get('adminAuth');
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'bad_form', message: '请用表单上传音频' }, 400);
    }
    const audio = audioFile(form, true);
    if ('error' in audio && audio.error) return c.json({ error: 'bad_file', message: audio.error }, 400);
    if (!audio.file || !audio.ext) return c.json({ error: 'no_file', message: '请选择音频文件' }, 400);
    const cover = await coverUrlFromForm(form);
    if ('error' in cover && cover.error) return c.json({ error: 'bad_cover', message: cover.error }, 400);

    const saved = await saveUpload(audio.file, 'audio', audio.ext);
    try {
      const track = await createSleepInterventionTrack({
        code: String(form.get('code') ?? '').trim().slice(0, 32),
        title: String(form.get('title') ?? '').trim().slice(0, 160) || '脑波干预',
        summary: String(form.get('summary') ?? '').trim().slice(0, 500),
        enabled: readBool(form.get('enabled'), true),
        audioUrl: saved.url,
        coverUrl: cover.url ?? null,
      });
      await writeAdminAuditLog({
        adminUserId: auth.sub,
        action: 'sleep_intervention.create',
        resourceType: 'content',
        resourceId: track.id,
        after: track,
        ip: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      });
      return c.json({ track }, 201);
    } catch (error) {
      return sendError(c, error);
    }
  },
);

adminSleepInterventionRoutes.patch(
  '/tracks/:id',
  requireAdminPermission('content:write'),
  async (c) => {
    const auth = c.get('adminAuth');
    const body = await c.req.json().catch(() => null) as {
      code?: string;
      title?: string;
      summary?: string;
      enabled?: boolean;
    } | null;
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'bad_json', message: '请提交要修改的字段' }, 400);
    }
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'not_found', message: '找不到这条音频' }, 404);
    try {
      const track = await updateSleepInterventionTrack(id, {
        code: body.code === undefined ? undefined : String(body.code).trim().slice(0, 32),
        title: body.title === undefined ? undefined : String(body.title).trim().slice(0, 160),
        summary: body.summary === undefined ? undefined : String(body.summary).trim().slice(0, 500),
        enabled: body.enabled === undefined ? undefined : readBool(body.enabled, false),
      });
      await writeAdminAuditLog({
        adminUserId: auth.sub,
        action: 'sleep_intervention.update',
        resourceType: 'content',
        resourceId: track.id,
        after: track,
        ip: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      });
      return c.json({ track });
    } catch (error) {
      return sendError(c, error);
    }
  },
);

adminSleepInterventionRoutes.post(
  '/tracks/:id/audio',
  requireAdminPermission('content:write'),
  async (c) => {
    const auth = c.get('adminAuth');
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'bad_form', message: '请用表单上传音频' }, 400);
    }
    const audio = audioFile(form, true);
    if ('error' in audio && audio.error) return c.json({ error: 'bad_file', message: audio.error }, 400);
    if (!audio.file || !audio.ext) return c.json({ error: 'no_file', message: '请选择音频文件' }, 400);
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'not_found', message: '找不到这条音频' }, 404);
    const saved = await saveUpload(audio.file, 'audio', audio.ext);
    try {
      const track = await updateSleepInterventionTrack(id, { audioUrl: saved.url });
      await writeAdminAuditLog({
        adminUserId: auth.sub,
        action: 'sleep_intervention.replace_audio',
        resourceType: 'content',
        resourceId: track.id,
        after: track,
        ip: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      });
      return c.json({ track });
    } catch (error) {
      return sendError(c, error);
    }
  },
);

adminSleepInterventionRoutes.delete(
  '/tracks/:id',
  requireAdminPermission('content:write'),
  async (c) => {
    const auth = c.get('adminAuth');
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'not_found', message: '找不到这条音频' }, 404);
    try {
      const track = await deleteSleepInterventionTrack(id);
      await writeAdminAuditLog({
        adminUserId: auth.sub,
        action: 'sleep_intervention.delete',
        resourceType: 'content',
        resourceId: track.id,
        before: track,
        ip: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      });
      return c.json({ ok: true });
    } catch (error) {
      return sendError(c, error);
    }
  },
);
