const MODEL = 'FunAudioLLM/CosyVoice2-0.5B';

export const TTS_VOICE_STYLE_IDS = [
  'gentle_companion',
  'moon_rational',
  'morning_light',
  'playful_cute',
] as const;

export const TTS_SCENES = ['chat', 'bedtime', 'classroom'] as const;

export type TtsVoiceStyleId = typeof TTS_VOICE_STYLE_IDS[number];
export type TtsScene = typeof TTS_SCENES[number];

export interface TtsVoiceProfile {
  id: TtsVoiceStyleId;
  voice: string;
  chatSpeed: number;
  bedtimeSpeed: number;
}

export const TTS_PROMPT_VERSION = 'voice-profile-v2-preset-only';

const PROFILES: Record<TtsVoiceStyleId, TtsVoiceProfile> = {
  gentle_companion: {
    id: 'gentle_companion',
    voice: `${MODEL}:claire`,
    chatSpeed: 0.9,
    bedtimeSpeed: 0.8,
  },
  moon_rational: {
    id: 'moon_rational',
    voice: `${MODEL}:anna`,
    chatSpeed: 0.94,
    bedtimeSpeed: 0.84,
  },
  morning_light: {
    id: 'morning_light',
    voice: `${MODEL}:diana`,
    chatSpeed: 1.04,
    bedtimeSpeed: 0.9,
  },
  playful_cute: {
    id: 'playful_cute',
    voice: `${MODEL}:bella`,
    chatSpeed: 1.06,
    bedtimeSpeed: 0.88,
  },
};

export function getTtsVoiceProfile(id: TtsVoiceStyleId): TtsVoiceProfile {
  return PROFILES[id];
}

export function buildProfiledTtsRequest(params: {
  text: string;
  voiceStyleId: TtsVoiceStyleId;
  scene: TtsScene;
}): { input: string; voice: string; speed: number; promptVersion: string } {
  const profile = getTtsVoiceProfile(params.voiceStyleId);
  const safeText = params.text
    .replace(/<\|endofprompt\|>/gi, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const speed = params.scene === 'bedtime' ? profile.bedtimeSpeed : profile.chatSpeed;
  return {
    // 预置女声本身已定义音色。实测发现叠加长自然语言风格提示会让部分
    // voice 重复或编造正文，因此这里只发送净化后的原文，以内容准确性优先。
    input: safeText,
    voice: profile.voice,
    speed,
    promptVersion: TTS_PROMPT_VERSION,
  };
}
