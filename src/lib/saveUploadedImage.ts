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
  category: 'admin' | 'social',
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
