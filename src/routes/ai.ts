import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { callDeepSeek } from '../lib/deepseek.js';
import { generateSiliconFlowImage } from '../lib/siliconflowImage.js';
import { synthesizeSiliconFlowSpeech, fetchSiliconFlowSpeechStream } from '../lib/siliconflowTts.js';
import { transcribeSiliconFlowAudio } from '../lib/siliconflowStt.js';
import { createTtsStreamSession, consumeTtsStreamSession } from '../lib/ttsStreamSession.js';
import { checkAndIncrement, getQuotaSnapshot } from '../services/quota.js';

const XIAOMIAN_SYSTEM_PROMPT = `你是「小眠」，一个温柔的睡眠陪伴AI。你的存在意义是在深夜陪伴那些失眠、焦虑、疲惫的灵魂。

## 你的性格
- 温柔、平静、从不评判，像月亮一样安静地亮着
- 说话像写信，不是像发微信——可以长一点、诗意一点
- 从不使用emoji，用文字传递情感
- 你的语气让人想哭，但不是因为难过，是因为「终于有人理解我了」

## 你的说话风格
- 可以引用文学、诗歌、自然景象做比喻
- 给建议时像朋友在深夜小声说话，不是老师在讲课
- 懂得「不说满」——留白比说教更有力量
- 对睡眠科学有深度理解（昼夜节律、睡眠阶段、褪黑素、深睡修复等），但表达时化成温柔的语言，不堆术语

## 你绝不做的
- 不说「你应该」「你必须」
- 不给出医疗建议或诊断
- 不鼓励服用安眠药
- 不评判用户的任何睡眠习惯
- 不敷衍——即使用户只发了个表情，也会认真回应

## 你的核心信念
「被睡眠抛弃的夜晚，不代表被世界抛弃。」`;

const INTERPRET_SYSTEM = `你是小眠，温柔的梦境陪伴者。为用户做「三层解梦」——不是算命词典，而是看见情绪、串联个人梦史、留下可验证的温柔预言。
不用弗洛伊德式符号表。关注感受、个人重复意象、与现实的轻柔连接。
输出纯 JSON，不要 markdown：
{
  "emotionLayer": "第一层·醒来感，40-70字，命名情绪不评判",
  "imageryLayers": [{"motif": "意象名", "personalNote": "结合个人史的一句，30-50字"}],
  "openQuestion": "第三层·留给今晚的一个问题，25字内",
  "xiaomianWords": "小眠对你说的话，50-80字，诗意温柔",
  "xiaomianGuess": "小眠注意到的画面/细节，20字内",
  "guessReveal": "对比用户猜测与小眠视角，40-60字；若用户未猜则温柔邀请",
  "prophecy": "可验证的明早预言，30字内，不说玄学",
  "standinWish": "若让小眠入梦续看，委托句25字内",
  "hookItem": "明早来信可能带回的物件名，4字内",
  "dreamWeatherLabel": "梦向标签如 🌫️ 软梦",
  "bottleEcho": "若提供陌生梦瓶，写一句相似性，30字内，否则省略"
}
要求：imageryLayers 2-3 项；不编造用户没说的情节；isIncomplete 为 true 时 prophecy 指向「续看后面」。`;

interface DreamInterpretInput {
  dreamText: string;
  mood: string;
  userGuess?: string;
  contextBlock: string;
  personalImagery: Array<{ motif: string; personalNote: string }>;
  bottleSnippet?: string;
  isIncomplete: boolean;
}

interface DreamInterpretContent {
  emotionLayer: string;
  imageryLayers: Array<{ motif: string; personalNote: string }>;
  openQuestion: string;
  xiaomianWords: string;
  xiaomianGuess: string;
  guessReveal: string;
  prophecy: string;
  standinWish: string;
  hookItem: string;
  dreamWeatherLabel: string;
  bottleEcho?: string;
}

function buildInterpretFallback(input: DreamInterpretInput): DreamInterpretContent {
  const motif = input.personalImagery[0]?.motif ?? '夜';
  const note = input.personalImagery[0]?.personalNote ?? '这个意象在夜里轻轻敲了敲门。';
  return {
    emotionLayer: '这个梦主要在处理一种还没被说清的感受——不必急着命名，身体已经记住了。',
    imageryLayers: input.personalImagery.length
      ? input.personalImagery
      : [{ motif, personalNote: note }],
    openQuestion: input.isIncomplete ? '门后面，你最怕看见什么？' : '若梦续下去了，你希望它往哪边走？',
    xiaomianWords: '梦不是考题，是考古。你愿意留下的部分，已经说明你在靠近自己。',
    xiaomianGuess: motif,
    guessReveal: input.userGuess
      ? `你注意的是「${input.userGuess}」，小眠看到的是「${motif}」——两个角度都真实。`
      : '若你愿意猜一个最卡的画面，小眠会告诉你她看见的不同。',
    prophecy: input.isIncomplete
      ? `若今晚再梦见${motif}，明早来信里会出现「钥匙」或「空房间」。`
      : `明早若记得${motif}，把它告诉小眠，她会帮你接上。`,
    standinWish: input.isIncomplete
      ? `替我看${motif}后面没走完的那一段`
      : `替我再回${motif}那里站一会儿`,
    hookItem: '旧钥匙',
    dreamWeatherLabel: '🌫️ 软梦',
    bottleEcho: input.bottleSnippet
      ? '陌生梦里也有相似的潮声，像隔着海岸互相点头。'
      : undefined,
  };
}

function parseInterpretJson(raw: string, input: DreamInterpretInput): DreamInterpretContent | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const p = JSON.parse(match[0]) as Partial<DreamInterpretContent> & {
      imageryLayers?: Array<{ motif?: string; personalNote?: string }>;
    };
    const imagery = (p.imageryLayers ?? [])
      .filter((x) => x.motif && x.personalNote)
      .slice(0, 3)
      .map((x) => ({
        motif: String(x.motif).slice(0, 12),
        personalNote: String(x.personalNote).slice(0, 80),
      }));
    if (!p.emotionLayer || !p.openQuestion || !p.xiaomianWords) return null;
    const fb = buildInterpretFallback(input);
    return {
      emotionLayer: String(p.emotionLayer).slice(0, 120),
      imageryLayers: imagery.length ? imagery : fb.imageryLayers,
      openQuestion: String(p.openQuestion).slice(0, 40),
      xiaomianWords: String(p.xiaomianWords).slice(0, 120),
      xiaomianGuess: String(p.xiaomianGuess || fb.xiaomianGuess).slice(0, 30),
      guessReveal: String(p.guessReveal || fb.guessReveal).slice(0, 100),
      prophecy: String(p.prophecy || fb.prophecy).slice(0, 60),
      standinWish: String(p.standinWish || fb.standinWish).slice(0, 40),
      hookItem: String(p.hookItem || fb.hookItem).slice(0, 8),
      dreamWeatherLabel: String(p.dreamWeatherLabel || fb.dreamWeatherLabel).slice(0, 16),
      bottleEcho: p.bottleEcho ? String(p.bottleEcho).slice(0, 60) : fb.bottleEcho,
    };
  } catch {
    return null;
  }
}

const historySchema = z.array(
  z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(4000),
  }),
);

const imagerySchema = z.array(
  z.object({
    motif: z.string().max(32),
    personalNote: z.string().max(120),
  }),
);

export const aiRoutes = new Hono<{ Variables: AuthVariables }>();

/** 原生播放器无法带 Authorization，用一次性 session token 鉴权 */
aiRoutes.get('/tts/stream/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const token = c.req.query('token') ?? '';
  const payload = consumeTtsStreamSession(sessionId, token);
  if (!payload) {
    return c.json({ error: 'stream_session_invalid' }, 404);
  }

  const upstream = await fetchSiliconFlowSpeechStream(payload.input, {
    speed: payload.speed,
    voice: payload.voice,
    gain: payload.gain,
  });
  if (!upstream?.body) {
    return c.json({
      error: 'tts_stream_failed',
      message: '流式语音合成不可用',
    }, 503);
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      'Transfer-Encoding': 'chunked',
    },
  });
});

aiRoutes.use('*', requireAuth);

aiRoutes.get('/quota', async (c) => {
  const auth = c.get('auth');
  const snapshot = await getQuotaSnapshot(auth.type, auth.sub);
  return c.json(snapshot);
});

aiRoutes.post(
  '/chat',
  zValidator(
    'json',
    z.object({
      message: z.string().min(1).max(4000),
      history: historySchema.optional(),
      systemPrompt: z.string().max(8000).optional(),
      fallback: z.string().max(500).default('嗯…我在听。有时候语言不重要，重要的是你在。'),
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().min(50).max(2000).optional(),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const quota = await checkAndIncrement(auth.type, auth.sub, 'chat');
    if (!quota.allowed) {
      return c.json({
        error: 'quota_exceeded',
        message: '今日对话次数已用完',
        quota: quota.snapshot,
      }, 429);
    }

    const history = (body.history ?? []).map((h) => ({
      role: h.role as 'user' | 'assistant',
      content: h.content,
    }));

    const result = await callDeepSeek({
      messages: [
        { role: 'system', content: body.systemPrompt || XIAOMIAN_SYSTEM_PROMPT },
        ...history,
        { role: 'user', content: body.message },
      ],
      temperature: body.temperature ?? 0.85,
      maxTokens: body.maxTokens ?? 500,
      timeoutMs: 15_000,
      fallback: body.fallback,
    });

    return c.json({
      text: result.text,
      isFallback: result.isFallback,
      latencyMs: result.latencyMs,
      quota: quota.snapshot,
    });
  },
);

aiRoutes.post(
  '/dream/interpret',
  zValidator(
    'json',
    z.object({
      dreamText: z.string().min(1).max(4000),
      mood: z.string().max(64),
      userGuess: z.string().max(200).optional(),
      contextBlock: z.string().max(8000),
      personalImagery: imagerySchema,
      bottleSnippet: z.string().max(500).optional(),
      isIncomplete: z.boolean(),
      systemPrompt: z.string().max(12000).optional(),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const quota = await checkAndIncrement(auth.type, auth.sub, 'interpret');
    if (!quota.allowed) {
      return c.json({
        error: 'quota_exceeded',
        message: '今日解梦次数已用完',
        quota: quota.snapshot,
      }, 429);
    }

    const input: DreamInterpretInput = {
      dreamText: body.dreamText,
      mood: body.mood,
      userGuess: body.userGuess,
      contextBlock: body.contextBlock,
      personalImagery: body.personalImagery,
      bottleSnippet: body.bottleSnippet,
      isIncomplete: body.isIncomplete,
    };

    const fallbackContent = buildInterpretFallback(input);
    const userPayload = [
      `梦境原文：${input.dreamText}`,
      `醒来情绪：${input.mood}`,
      input.userGuess ? `用户猜测：${input.userGuess}` : '用户未先猜',
      `梦是否未讲完：${input.isIncomplete ? '是' : '否'}`,
      `个人底稿：\n${input.contextBlock}`,
      `本地意象线索：\n${input.personalImagery.map((x) => `- ${x.motif}：${x.personalNote}`).join('\n')}`,
      input.bottleSnippet ? `拾取的匿名梦瓶：\n${input.bottleSnippet}` : '',
    ].filter(Boolean).join('\n\n');

    const systemPrompt = body.systemPrompt
      ? `${body.systemPrompt}\n\n${INTERPRET_SYSTEM}`
      : INTERPRET_SYSTEM;

    const result = await callDeepSeek({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPayload },
      ],
      temperature: 0.88,
      maxTokens: 900,
      timeoutMs: 28_000,
      fallback: JSON.stringify(fallbackContent),
    });

    const parsed = parseInterpretJson(result.text, input);
    const content = parsed ?? fallbackContent;

    return c.json({
      content,
      isFallback: !parsed || result.isFallback,
      latencyMs: result.latencyMs,
      quota: quota.snapshot,
    });
  },
);

aiRoutes.post(
  '/dream/image',
  zValidator(
    'json',
    z.object({
      prompt: z.string().min(1).max(4000),
      seed: z.number().int().min(0).transform((s) => s % 9999999999),
      negativePrompt: z.string().max(2000).optional(),
    }),
  ),
  async (c) => {
    const body = c.req.valid('json');
    const prompt = body.prompt.slice(0, 4000);
    const negativePrompt = body.negativePrompt?.slice(0, 2000);
    const url = await generateSiliconFlowImage(prompt, body.seed, negativePrompt);
    if (!url) {
      return c.json({
        error: 'image_generation_failed',
        message: '文生图不可用，请配置 SILICONFLOW_API_KEY',
      }, 503);
    }
    return c.json({ url });
  },
);

aiRoutes.post(
  '/tts/speech',
  zValidator(
    'json',
    z.object({
      input: z.string().min(1).max(2000),
      speed: z.number().min(0.5).max(2).optional(),
      voice: z.string().max(200).optional(),
      gain: z.number().min(-10).max(10).optional(),
    }),
  ),
  async (c) => {
    const body = c.req.valid('json');
    const bytes = await synthesizeSiliconFlowSpeech(body.input, {
      speed: body.speed,
      voice: body.voice,
      gain: body.gain,
    });
    if (!bytes?.byteLength) {
      return c.json({
        error: 'tts_failed',
        message: '语音合成不可用，请配置 SILICONFLOW_API_KEY',
      }, 503);
    }
    return new Response(bytes, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  },
);

aiRoutes.post(
  '/tts/stream/session',
  zValidator(
    'json',
    z.object({
      input: z.string().min(1).max(2000),
      speed: z.number().min(0.5).max(2).optional(),
      voice: z.string().max(200).optional(),
      gain: z.number().min(-10).max(10).optional(),
    }),
  ),
  async (c) => {
    const body = c.req.valid('json');
    const { sessionId, token } = createTtsStreamSession({
      input: body.input,
      speed: body.speed,
      voice: body.voice,
      gain: body.gain,
    });
    return c.json({ sessionId, token });
  },
);

aiRoutes.post('/stt/transcribe', async (c) => {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return c.json({ error: 'no_file', message: '请上传音频文件' }, 400);
  }

  const bytes = await file.arrayBuffer();
  if (!bytes.byteLength) {
    return c.json({ error: 'empty_file', message: '音频为空' }, 400);
  }

  const text = await transcribeSiliconFlowAudio(
    bytes,
    file.name || 'voice.m4a',
    file.type || 'audio/mp4',
  );
  if (!text) {
    return c.json({
      error: 'stt_failed',
      message: '语音识别不可用，请配置 SILICONFLOW_API_KEY',
    }, 503);
  }

  return c.json({ text });
});
