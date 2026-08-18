import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBuffer } from 'music-metadata';
import { config } from '../src/config.js';
import { transcribeSiliconFlowAudio } from '../src/lib/siliconflowStt.js';
import { synthesizeSiliconFlowSpeech } from '../src/lib/siliconflowTts.js';
import {
  buildProfiledTtsRequest,
  TTS_VOICE_STYLE_IDS,
} from '../src/lib/ttsVoiceProfiles.js';

const SAMPLE_TEXT = '今晚辛苦了。现在把肩膀轻轻放松，让呼吸慢下来，我会陪你安静地走进睡意。';

function normalizeSpeechText(value: string): string {
  return value.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

function editSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (!left.length || !right.length) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

if (!config.siliconflowApiKey) {
  throw new Error('SILICONFLOW_API_KEY 未配置，无法执行四声线实测');
}

const outputDir = await mkdtemp(join(tmpdir(), 'xiaomian-voice-acceptance-'));
const hashes: string[] = [];
const voices: string[] = [];

for (const voiceStyleId of TTS_VOICE_STYLE_IDS) {
  const request = buildProfiledTtsRequest({
    text: SAMPLE_TEXT,
    voiceStyleId,
    scene: 'bedtime',
  });
  const result = await synthesizeSiliconFlowSpeech(request.input, {
    voice: request.voice,
    speed: request.speed,
  });
  assert.ok(result.bytes, `${voiceStyleId}: ${result.code ?? 'empty_audio'}`);
  assert.ok(result.bytes.byteLength > 1_024, `${voiceStyleId}: audio_too_small`);

  const bytes = new Uint8Array(result.bytes);
  const metadata = await parseBuffer(bytes, { mimeType: 'audio/mpeg', size: bytes.byteLength }, {
    duration: true,
    skipCovers: true,
  });
  const durationSec = metadata.format.duration ?? 0;
  assert.ok(durationSec > 0, `${voiceStyleId}: invalid_duration`);
  const transcription = await transcribeSiliconFlowAudio(
    result.bytes,
    `${voiceStyleId}.mp3`,
    'audio/mpeg',
  );
  assert.ok(transcription.text, `${voiceStyleId}: transcription_${transcription.code ?? 'empty'}`);
  const expectedText = normalizeSpeechText(SAMPLE_TEXT);
  const actualText = normalizeSpeechText(transcription.text);
  const similarity = editSimilarity(expectedText, actualText);
  assert.ok(similarity >= 0.78, `${voiceStyleId}: content_similarity_${similarity.toFixed(3)}`);
  assert.ok(
    actualText.length <= Math.ceil(expectedText.length * 1.35),
    `${voiceStyleId}: unexpected_extra_speech`,
  );

  const hash = createHash('sha256').update(bytes).digest('hex');
  const path = join(outputDir, `${voiceStyleId}.mp3`);
  await writeFile(path, bytes);
  hashes.push(hash);
  voices.push(request.voice);
  console.log(JSON.stringify({
    voiceStyleId,
    providerVoice: request.voice,
    speed: request.speed,
    bytes: bytes.byteLength,
    durationSec: Number(durationSec.toFixed(2)),
    transcriptSimilarity: Number(similarity.toFixed(3)),
    sha256: hash,
  }));
}

assert.equal(new Set(voices).size, TTS_VOICE_STYLE_IDS.length, '四个 profile 必须映射不同 voice');
assert.equal(new Set(hashes).size, TTS_VOICE_STYLE_IDS.length, '四种实测音频哈希必须互异');
console.log(`四声线实测通过，样本目录：${outputDir}`);
