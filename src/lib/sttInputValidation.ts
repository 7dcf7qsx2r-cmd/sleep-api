import { fileTypeFromBuffer } from 'file-type';
import { parseBuffer } from 'music-metadata';
import { config } from '../config.js';

// ISO-BMFF 容器：iOS 写 `M4A ` 品牌（audio/x-m4a），部分安卓（如华为）MPEG_4 实际写 `3gp4`（video/3gpp）。
const MP4_FAMILY = [
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'video/mp4',
  'audio/3gpp',
  'video/3gpp',
];

const MIME_ALIASES: Record<string, string[]> = {
  'audio/mp4': MP4_FAMILY,
  'audio/x-m4a': MP4_FAMILY,
  'video/mp4': MP4_FAMILY,
  'video/3gpp': MP4_FAMILY,
  'audio/mpeg': ['audio/mpeg', 'audio/mp3'],
  'audio/wav': ['audio/wav', 'audio/wave', 'audio/x-wav'],
  'audio/ogg': ['audio/ogg'],
  'audio/webm': ['audio/webm', 'video/webm'],
  'audio/flac': ['audio/flac', 'audio/x-flac'],
};

const PROVIDER_MIME: Record<string, string> = {
  'audio/x-m4a': 'audio/mp4',
  'video/mp4': 'audio/mp4',
  'video/3gpp': 'audio/mp4',
};

export class SttInputError extends Error {
  constructor(
    public readonly code: 'audio_too_large' | 'audio_type_unsupported' | 'audio_invalid' | 'audio_too_long',
    public readonly status: 413 | 415 | 422,
  ) {
    super(code);
    this.name = 'SttInputError';
  }
}

function normalizeMime(value: string): string {
  return value.toLowerCase().split(';')[0]?.trim() ?? '';
}

function mimeMatches(detected: string, supplied: string): boolean {
  const suppliedMime = normalizeMime(supplied);
  return (MIME_ALIASES[detected] ?? [detected]).includes(suppliedMime);
}

export async function validateSttAudio(file: File): Promise<{
  bytes: Uint8Array;
  durationSec: number;
  mime: string;
}> {
  if (file.size <= 0) throw new SttInputError('audio_invalid', 422);
  if (file.size > config.voice.maxSttBytes) {
    throw new SttInputError('audio_too_large', 413);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected || !detected.mime.startsWith('audio/') && !MIME_ALIASES[detected.mime]) {
    throw new SttInputError('audio_type_unsupported', 415);
  }
  if (!mimeMatches(detected.mime, file.type)) {
    throw new SttInputError('audio_type_unsupported', 415);
  }

  const mime = PROVIDER_MIME[detected.mime] ?? detected.mime;
  let durationSec = 0;
  try {
    const metadata = await parseBuffer(
      bytes,
      { mimeType: mime, size: file.size },
      { duration: true, skipCovers: true },
    );
    durationSec = metadata.format.duration ?? 0;
  } catch {
    throw new SttInputError('audio_invalid', 422);
  }

  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new SttInputError('audio_invalid', 422);
  }
  if (durationSec > config.voice.maxSttDurationSec) {
    throw new SttInputError('audio_too_long', 413);
  }

  return { bytes, durationSec, mime };
}
