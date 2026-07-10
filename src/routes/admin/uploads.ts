import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import {
  requireAdminAuth,
  type AdminVariables,
} from '../../middleware/adminAuth.js';
import { hasPermission } from '../../lib/adminJwt.js';

export const adminUploadRoutes = new Hono<{ Variables: AdminVariables }>();

adminUploadRoutes.use('*', requireAdminAuth);

const IMAGE_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function safeName(name: string) {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'image';
}

adminUploadRoutes.post('/images', async (c) => {
  const auth = c.get('adminAuth');
  const canUpload = ['products:write', 'experts:write', 'content:write'].some((permission) =>
    hasPermission(auth.permissions, permission),
  );
  if (!canUpload) {
    return c.json({ error: 'forbidden', message: 'Missing upload permission' }, 403);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'bad_form', message: '请上传图片文件' }, 400);
  }

  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return c.json({ error: 'no_file', message: '请上传图片文件' }, 400);
  }

  const ext = IMAGE_MIME_EXT[file.type];
  if (!ext) {
    return c.json({ error: 'unsupported_type', message: '仅支持 jpg/png/webp/gif 图片' }, 400);
  }

  const bytes = await file.arrayBuffer();
  if (bytes.byteLength <= 0) {
    return c.json({ error: 'empty_file', message: '图片为空' }, 400);
  }
  if (bytes.byteLength > 5 * 1024 * 1024) {
    return c.json({ error: 'file_too_large', message: '图片不能超过 5MB' }, 400);
  }

  const today = new Date().toISOString().slice(0, 10);
  const relativeDir = path.join('uploads', 'admin', 'images', today);
  const absoluteDir = path.resolve(process.cwd(), relativeDir);
  await mkdir(absoluteDir, { recursive: true });

  const filename = `${Date.now()}-${safeName(file.name)}.${ext}`;
  const relativePath = path.join(relativeDir, filename).replace(/\\/g, '/');
  await writeFile(path.resolve(process.cwd(), relativePath), Buffer.from(bytes));

  return c.json({
    url: `/${relativePath}`,
    filename,
    size: bytes.byteLength,
    mimeType: file.type,
  });
});
