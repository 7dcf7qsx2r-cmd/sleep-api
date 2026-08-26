import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

export async function saveUploadedImage(
  file: File,
  category: 'admin' | 'social' | 'ai',
): Promise<{ url: string; filename: string; size: number; mimeType: string } | { error: string; message: string; status: number }> {
  const ext = IMAGE_MIME_EXT[file.type];
  if (!ext) {
    return { error: 'unsupported_type', message: '仅支持 jpg/png/webp/gif 图片', status: 400 };
  }

  const bytes = await file.arrayBuffer();
  if (bytes.byteLength <= 0) {
    return { error: 'empty_file', message: '图片为空', status: 400 };
  }
  if (bytes.byteLength > 5 * 1024 * 1024) {
    return { error: 'file_too_large', message: '图片不能超过 5MB', status: 400 };
  }

  const today = new Date().toISOString().slice(0, 10);
  const relativeDir = path.join('uploads', category, 'images', today);
  const absoluteDir = path.resolve(process.cwd(), relativeDir);
  await mkdir(absoluteDir, { recursive: true });

  const filename = `${Date.now()}-${safeName(file.name)}.${ext}`;
  const relativePath = path.join(relativeDir, filename).replace(/\\/g, '/');
  await writeFile(path.resolve(process.cwd(), relativePath), Buffer.from(bytes));

  return {
    url: `/${relativePath}`,
    filename,
    size: bytes.byteLength,
    mimeType: file.type,
  };
}

/** 把第三方临时图转存到本机 /uploads，失败返回 null（调用方可回退原 URL） */
export async function persistRemoteImage(
  remoteUrl: string,
  category: 'admin' | 'social' | 'ai' = 'ai',
): Promise<string | null> {
  if (!/^https?:\/\//i.test(remoteUrl)) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    const res = await fetch(remoteUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;

    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const ext = IMAGE_MIME_EXT[mime];
    if (!ext) return null;

    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength <= 0 || bytes.byteLength > 5 * 1024 * 1024) return null;

    const today = new Date().toISOString().slice(0, 10);
    const relativeDir = path.join('uploads', category, 'images', today);
    await mkdir(path.resolve(process.cwd(), relativeDir), { recursive: true });
    const filename = `${Date.now()}-gen.${ext}`;
    const relativePath = path.join(relativeDir, filename).replace(/\\/g, '/');
    await writeFile(path.resolve(process.cwd(), relativePath), bytes);
    return `/${relativePath}`;
  } catch {
    return null;
  }
}
