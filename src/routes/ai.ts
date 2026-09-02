import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { callDeepSeek } from '../lib/deepseek.js';
import { generateSiliconFlowImage } from '../lib/siliconflowImage.js';
import { persistRemoteImage } from '../lib/saveUploadedImage.js';
import { parseChatToolCalls } from '../lib/chatToolCalls.js';
import { synthesizeSiliconFlowSpeech } from '../lib/siliconflowTts.js';
import { transcribeSiliconFlowAudio } from '../lib/siliconflowStt.js';
import { checkAndConsume, checkAndIncrement, getQuotaSnapshot } from '../services/quota.js';
import { ownerFromAuth } from '../lib/owner.js';
import { loadSleepNights } from '../services/sleepNights.js';
import { generateHomeDailyInsight } from '../services/homeInsight.js';
import { config } from '../config.js';
import { acquireConcurrency } from '../services/concurrency.js';
import { SttInputError, validateSttAudio } from '../lib/sttInputValidation.js';
import {
  buildProfiledTtsRequest,
  TTS_SCENES,
  TTS_VOICE_STYLE_IDS,
} from '../lib/ttsVoiceProfiles.js';
import { recordVoiceEvent } from '../services/voiceMetrics.js';
import { consumeFixedWindow } from '../services/rateLimit.js';
import { canCallVoiceProvider, recordVoiceProviderResult } from '../services/providerCircuit.js';
import {
  parseConsultTurnPayload,
  validateConsultTurnPayload,
} from '../lib/consultTurnCodec.js';

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

aiRoutes.use('*', requireAuth);

aiRoutes.get('/quota', async (c) => {
  const auth = c.get('auth');
  const snapshot = await getQuotaSnapshot(auth.type, auth.sub);
  return c.json(snapshot);
});

aiRoutes.post(
  '/home-insight',
  zValidator(
    'json',
    z.object({
      nickname: z.string().max(64).default('朋友'),
      dreamCount: z.number().int().min(0).max(9999).default(0),
      sleepType: z.string().max(64).optional(),
      questionnaireDone: z.boolean().optional(),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const owner = ownerFromAuth(auth);
    const { nights } = await loadSleepNights(owner);
    const input = {
      nickname: body.nickname,
      dreamCount: body.dreamCount,
      sleepType: body.sleepType,
      questionnaireDone: body.questionnaireDone ?? false,
      nights,
    };
    const insight = await generateHomeDailyInsight(input);
    return c.json({ insight });
  },
);

/** 第七章 · 今夜态壁纸文案精修（不改五维分数，只润色标题/金句） */
const TONIGHT_PORTRAIT_SYSTEM = `你是「小眠」。用户刚完成入夜仪式，本地已算出「今夜态」五维分数与草稿文案。
你的任务：在不改变数值含义的前提下，精修壁纸标题与金句，让用户有被理解、可带走的获得感。

硬性规则：
- 输出纯 JSON，不要 markdown
- 不是睡眠报告，不写分数、深浅睡、效率、诊断、病理词
- 不评判、不说教、不用 emoji
- title：2–8 个汉字的意象名，像天气或景物（例：封口的潮汐、未散的薄雾）
- oneLiner：一句 16–36 字，尽量回声用户原词/选项；诗意但具体
- careHint：一条非说教行动提示，18 字内
- echo：点名用户痕迹的短词，12 字内；若无则空字符串

JSON 形状：
{"title":"...","oneLiner":"...","careHint":"...","echo":"..."}`;

interface TonightPortraitRefineInput {
  title: string;
  oneLiner?: string;
  careHint?: string;
  echo?: string;
  weather?: string;
  mood?: string;
  residueIds?: string[];
  freeText?: string;
  features?: {
    arousal?: number;
    residue?: number;
    body?: number;
    moodWeather?: number;
    sleepGate?: number;
  };
}

function clampPortraitText(s: string, max: number): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

function buildTonightPortraitFallback(input: TonightPortraitRefineInput): {
  title: string;
  oneLiner: string;
  careHint: string;
  echo: string;
} {
  const echo = clampPortraitText(input.echo || input.freeText || '', 16);
  return {
    title: clampPortraitText(input.title || '今夜薄雾', 16),
    oneLiner: clampPortraitText(
      input.oneLiner
        || (echo ? `「${echo}」还在，先把它轻轻放下。` : '不是成绩单，是今晚的天气。'),
      48,
    ),
    careHint: clampPortraitText(input.careHint || '先抽贴合今夜态的一幕。', 36),
    echo,
  };
}

function parseTonightPortraitJson(
  raw: string,
  input: TonightPortraitRefineInput,
): ReturnType<typeof buildTonightPortraitFallback> | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const p = JSON.parse(match[0]) as Partial<ReturnType<typeof buildTonightPortraitFallback>>;
    if (!p.title || !p.oneLiner) return null;
    const fb = buildTonightPortraitFallback(input);
    return {
      title: clampPortraitText(String(p.title), 16) || fb.title,
      oneLiner: clampPortraitText(String(p.oneLiner), 48) || fb.oneLiner,
      careHint: clampPortraitText(String(p.careHint || fb.careHint), 36),
      echo: clampPortraitText(String(p.echo ?? fb.echo), 16),
    };
  } catch {
    return null;
  }
}

aiRoutes.post(
  '/tonight-portrait',
  zValidator(
    'json',
    z.object({
      title: z.string().min(1).max(32),
      oneLiner: z.string().max(80).optional(),
      careHint: z.string().max(60).optional(),
      echo: z.string().max(32).optional(),
      weather: z.string().max(32).optional(),
      mood: z.string().max(32).optional(),
      residueIds: z.array(z.string().max(24)).max(8).optional(),
      freeText: z.string().max(64).optional(),
      features: z.object({
        arousal: z.number().min(0).max(1).optional(),
        residue: z.number().min(0).max(1).optional(),
        body: z.number().min(0).max(1).optional(),
        moodWeather: z.number().min(0).max(1).optional(),
        sleepGate: z.number().min(0).max(1).optional(),
      }).optional(),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const quota = await checkAndIncrement(auth.type, auth.sub, 'chat');
    if (!quota.allowed) {
      const fallback = buildTonightPortraitFallback(body);
      return c.json({
        ...fallback,
        isFallback: true,
        error: 'quota_exceeded',
        quota: quota.snapshot,
      });
    }

    const f = body.features;
    const userMsg = [
      `本地草稿标题：${body.title}`,
      body.oneLiner ? `本地金句：${body.oneLiner}` : '',
      body.careHint ? `本地提示：${body.careHint}` : '',
      `心情：${body.mood ?? '未知'}`,
      `主题天气：${body.weather ?? '未知'}`,
      body.residueIds?.length ? `感受选项：${body.residueIds.join('、')}` : '',
      body.freeText?.trim() ? `用户原话：${body.freeText.trim()}` : '',
      body.echo ? `回声草稿：${body.echo}` : '',
      f
        ? `五维(0-1)：唤醒=${f.arousal?.toFixed(2) ?? '-'} 残留=${f.residue?.toFixed(2) ?? '-'} 身体=${f.body?.toFixed(2) ?? '-'} 心气=${f.moodWeather?.toFixed(2) ?? '-'} 闸门=${f.sleepGate?.toFixed(2) ?? '-'}`
        : '',
      '请精修 title / oneLiner / careHint / echo，输出 JSON。',
    ].filter(Boolean).join('\n');

    const fallback = buildTonightPortraitFallback(body);
    const result = await callDeepSeek({
      messages: [
        { role: 'system', content: TONIGHT_PORTRAIT_SYSTEM },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.86,
      maxTokens: 220,
      timeoutMs: 14_000,
      fallback: JSON.stringify(fallback),
    });

    const parsed = parseTonightPortraitJson(result.text, body);
    const content = parsed ?? fallback;

    return c.json({
      ...content,
      isFallback: !parsed || result.isFallback,
      latencyMs: result.latencyMs,
      quota: quota.snapshot,
    });
  },
);

const COMPANION_STYLE_ROUTE_SYSTEM = `你是小眠 Tab 的「对话意图与风险路由器」。先判断用户希望 AI 做什么，再独立判断健康风险；不要仅凭出现“失眠、焦虑、痛”等词就选择咨询。

## 请求动作 intent
- companionship：倾诉、陪伴、记梦、随意聊，或明确说“陪我聊/不要分析”。
- education：询问一般原理、含义、科学知识、方法比较，如“为什么失眠”“焦虑为什么影响睡眠”。
- assessment：请求判断个人症状、用药、严重程度、是否检查或就医。

## 风险 risk
- none：日常表达或一般知识。
- personal_health：具体个人症状、持续时间、功能受损或个人用药问题。
- urgent：急症红旗，或自伤、自杀、轻生等心理危机信号。

## 判定原则
1. urgent → consult，redFlag=true，不得降级。
2. 用户明确要求陪伴且无 urgent → chat，即使提到轻度失眠或焦虑。
3. 一般“为什么/是什么/原理/方法” → explain，即使句中出现失眠、焦虑。
4. 个人症状 + 判断/处置/用药/就医诉求 → consult。
5. 短承接语“嗯/然后呢/继续”可延续【上轮风格】，continuation=true；新诉求立即切换。
6. 【健康摘要】只辅助风险判断，不替代本轮请求动作。
7. 问卷偏好只在低置信模糊输入时作弱先验。

输出纯 JSON，不要 markdown，不要解释：
{"style":"chat|explain|consult","intent":"companionship|education|assessment|unknown","risk":"none|personal_health|urgent","confidence":0.86,"continuation":false,"reason":"30字内中文依据","redFlag":false}
其中 confidence 必须是 0 到 1 的真实置信度，不要固定照抄示例值。`;

aiRoutes.post(
  '/companion-style-route',
  zValidator(
    'json',
    z.object({
      message: z.string().min(1).max(2000),
      history: historySchema.optional(),
      healthBrief: z.string().max(3000).optional(),
      personaCompanionStyle: z.enum(['listen', 'comfort', 'guide', 'quiet']).optional(),
      previousStyle: z.enum(['chat', 'explain', 'consult']).optional(),
    }),
  ),
  async (c) => {
    const body = c.req.valid('json');
    const history = (body.history ?? []).map((h) => ({
      role: h.role as 'user' | 'assistant',
      content: h.content,
    }));

    const userParts = [
      body.healthBrief?.trim()
        ? `【健康摘要要点】\n${body.healthBrief.trim()}`
        : '【健康摘要要点】暂无',
      body.personaCompanionStyle
        ? `【问卷陪伴偏好】${body.personaCompanionStyle}`
        : '',
      body.previousStyle ? `【上轮风格】${body.previousStyle}` : '',
      `【用户本轮】${body.message}`,
    ].filter(Boolean);

    const result = await callDeepSeek({
      messages: [
        { role: 'system', content: COMPANION_STYLE_ROUTE_SYSTEM },
        ...history,
        { role: 'user', content: userParts.join('\n\n') },
      ],
      temperature: 0.2,
      maxTokens: 180,
      timeoutMs: 12_000,
      fallback: '{"style":"chat","intent":"unknown","risk":"none","confidence":0,"continuation":false,"reason":"路由服务降级，由客户端规则接管","redFlag":false}',
    });

    return c.json({
      text: result.text,
      isFallback: result.isFallback,
      latencyMs: result.latencyMs,
    });
  },
);

const CONSULT_JSON_RETRY = '【请严格按 JSON schema 输出，仅返回一个 JSON 对象，不要 markdown】';

const consultPhaseSchema = z.enum(['triage', 'clarify', 'formulate', 'plan', 'safety']);

aiRoutes.post(
  '/consult-turn',
  zValidator(
    'json',
    z.object({
      message: z.string().min(1).max(4000),
      history: historySchema.optional(),
      systemPrompt: z.string().min(1).max(12000),
      outputPhase: consultPhaseSchema,
      fallbackSpeech: z.string().max(2000).default('专业分析已更新'),
      temperature: z.number().min(0).max(1).optional(),
      maxTokens: z.number().min(50).max(2400).optional(),
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

    const llmBase = {
      temperature: body.temperature ?? 0.35,
      maxTokens: body.maxTokens ?? 1800,
      timeoutMs: 90_000,
      fallback: body.fallbackSpeech,
    };

    const history = (body.history ?? []).slice(-12);
    const runOnce = (userContent: string) => callDeepSeek({
      messages: [
        { role: 'system', content: body.systemPrompt },
        ...history,
        { role: 'user', content: userContent },
      ],
      ...llmBase,
    });

    let result = await runOnce(body.message);
    let payload = parseConsultTurnPayload(result.text);
    let validated = Boolean(payload && validateConsultTurnPayload(payload, body.outputPhase));

    if (!validated && !result.isFallback) {
      const retry = await runOnce(`${body.message}\n\n${CONSULT_JSON_RETRY}`);
      const retryPayload = parseConsultTurnPayload(retry.text);
      if (retryPayload && validateConsultTurnPayload(retryPayload, body.outputPhase)) {
        payload = retryPayload;
        result = retry;
        validated = true;
      }
    }

    return c.json({
      payload: validated ? payload : null,
      text: result.text,
      isFallback: result.isFallback,
      validated,
      latencyMs: result.latencyMs,
      quota: quota.snapshot,
    });
  },
);

aiRoutes.post(
  '/chat',
  zValidator(
    'json',
    z.object({
      message: z.string().min(1).max(4000),
      history: historySchema.optional(),
      systemPrompt: z.string().max(12000).optional(),
      personaContext: z.string().max(4000).optional(),
      fallback: z.string().max(500).default('嗯…我在听。有时候语言不重要，重要的是你在。'),
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().min(50).max(4000).optional(),
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

    let systemContent = body.systemPrompt || XIAOMIAN_SYSTEM_PROMPT;
    if (body.personaContext?.trim() && !body.systemPrompt) {
      systemContent = `${XIAOMIAN_SYSTEM_PROMPT}\n\n${body.personaContext.trim()}`;
    }

    const result = await callDeepSeek({
      messages: [
        { role: 'system', content: systemContent },
        ...history,
        { role: 'user', content: body.message },
      ],
      temperature: body.temperature ?? 0.85,
      maxTokens: body.maxTokens ?? 2000,
      timeoutMs: 90_000,
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

const TOOL_ROUTER_SYSTEM = `你是小眠的工具路由器。只输出一个 JSON 对象，不要 markdown，不要解释。
格式：{"toolCalls":[{"name":"工具名","arguments":{}}]}
规则：
1. 只能从用户给出的工具列表里选。
2. 最多 1 个工具。不需要工具时输出 {"toolCalls":[]}。
3. arguments 必须是对象，没有参数就用 {}。`;

aiRoutes.post(
  '/chat-with-tools',
  zValidator(
    'json',
    z.object({
      message: z.string().min(1).max(4000),
      tools: z.array(z.object({
        name: z.string().min(1).max(64),
        description: z.string().max(400),
        parameters: z.record(z.string(), z.string()).optional(),
      })).min(1).max(24),
      history: historySchema.optional(),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const quota = await checkAndIncrement(auth.type, auth.sub, 'chat');
    if (!quota.allowed) {
      return c.json({
        toolCalls: [],
        isFallback: true,
        error: 'quota_exceeded',
        quota: quota.snapshot,
      });
    }

    const catalog = body.tools.map((tool) => {
      const params = tool.parameters
        ? Object.entries(tool.parameters).map(([key, value]) => `${key}:${value}`).join(', ')
        : '';
      return `- ${tool.name}: ${tool.description}${params ? ` (${params})` : ''}`;
    }).join('\n');

    const history = (body.history ?? []).map((h) => ({
      role: h.role as 'user' | 'assistant',
      content: h.content,
    }));

    const result = await callDeepSeek({
      messages: [
        { role: 'system', content: TOOL_ROUTER_SYSTEM },
        ...history,
        { role: 'user', content: `可选工具：\n${catalog}\n\n用户：${body.message}` },
      ],
      temperature: 0.1,
      maxTokens: 220,
      timeoutMs: 14_000,
      fallback: '{"toolCalls":[]}',
    });

    const toolCalls = parseChatToolCalls(
      result.text,
      body.tools.map((tool) => tool.name),
    );

    return c.json({
      toolCalls,
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

const STANDIN_REPORT_SYSTEM = `你是小眠。用户睡着了，你替他/她进入梦境走一趟，天亮后回来把梦讲给用户听。
输出必须是纯 JSON，不要 markdown：
{
  "title": "梦境标题，15字内，温柔有悬念",
  "acts": ["第一幕50字", "第二幕50字", "第三幕50字"],
  "standinMessage": "小眠第一人称对用户说的话，60字",
  "keywords": ["意象1","意象2","意象3"],
  "mood": "情绪基调如平静中带释然",
  "item": "可带走的小物件名",
  "contrastNote": "若用户本人去会怎样，40字"
}
要求：三幕有叙事弧线；有具体感官细节；温柔诗意；不评判用户；始终是小眠在说话。`;

interface StandinReportContent {
  title: string;
  acts: [string, string, string];
  standinMessage: string;
  keywords: string[];
  mood: string;
  item: string;
  contrastNote: string;
}

interface StandinReportInput {
  wish: string;
  personaLabel: string;
  risk: 'calm' | 'curious' | 'wild';
  isContinuation?: boolean;
  priorTitle?: string;
  continuationChoice?: string;
  isAutonomous?: boolean;
  isLazyBed?: boolean;
  seriesEpisode?: number;
  rareOverlay?: Partial<Pick<StandinReportContent, 'title' | 'item' | 'standinMessage'>>;
  bedtimeClosing?: string;
  completionDreamText?: string;
  seasonalHint?: string;
  deepSleepHint?: string;
  storyCliffhanger?: string;
  storyHookItem?: string;
  storyEpisodeTitle?: string;
  storyChoice?: string;
}

function buildStandinFallback(input: StandinReportInput): StandinReportContent {
  const wish = input.wish.slice(0, 40) || '远方';
  const overlay = input.rareOverlay;
  return {
    title: overlay?.title ?? `小眠在${wish}等你`,
    acts: [
      '薄雾里出现你想见的地方，空气有雨后的味道。',
      '我先你半步踏上了那条路。',
      `天边亮起一线光，${wish}在远处安静等着。`,
    ],
    standinMessage: overlay?.standinMessage
      ?? '我替你去看了。那里有你想见的光——我确定，那就是你想去的地方。',
    keywords: ['路', '光', '风'],
    mood: '平静中带期待',
    item: overlay?.item ?? '一枚温热的石子',
    contrastNote: '你若亲自去，也许会多停一会儿，但我替你记住了那一刻。',
  };
}

function parseStandinReportJson(raw: string): StandinReportContent | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Partial<StandinReportContent> & { acts?: string[] };
    const acts = (parsed.acts || []).filter(Boolean).slice(0, 3);
    while (acts.length < 3) acts.push('梦境层薄雾弥漫，我继续向前走。');
    return {
      title: (parsed.title || '小眠回来了').slice(0, 20),
      acts: acts as [string, string, string],
      standinMessage: parsed.standinMessage || '我替你走完了这一程。',
      keywords: (parsed.keywords || ['梦', '夜', '路']).slice(0, 4),
      mood: parsed.mood || '平静',
      item: parsed.item || '一缕月光',
      contrastNote: parsed.contrastNote || '你醒来时，会记得我替你看过的风景。',
    };
  } catch {
    return null;
  }
}

const standinReportSchema = z.object({
  wish: z.string().min(1).max(500),
  personaLabel: z.string().min(1).max(40),
  risk: z.enum(['calm', 'curious', 'wild']),
  isContinuation: z.boolean().optional(),
  priorTitle: z.string().max(40).optional(),
  continuationChoice: z.string().max(80).optional(),
  isAutonomous: z.boolean().optional(),
  isLazyBed: z.boolean().optional(),
  seriesEpisode: z.number().int().optional(),
  rareOverlay: z.object({
    title: z.string().optional(),
    item: z.string().optional(),
    standinMessage: z.string().optional(),
  }).optional(),
  bedtimeClosing: z.string().max(200).optional(),
  completionDreamText: z.string().max(2000).optional(),
  seasonalHint: z.string().max(200).optional(),
  deepSleepHint: z.string().max(200).optional(),
  storyCliffhanger: z.string().max(400).optional(),
  storyHookItem: z.string().max(40).optional(),
  storyEpisodeTitle: z.string().max(40).optional(),
  storyChoice: z.string().max(80).optional(),
});

aiRoutes.post(
  '/dream/standin-report',
  zValidator('json', standinReportSchema),
  async (c) => {
    const input = c.req.valid('json');
    const riskHint = input.risk === 'wild'
      ? '剧情可自我改写，意象更超现实'
      : input.risk === 'curious'
        ? '多一些意外意象'
        : '温柔平稳';

    const userMsg = [
      `用户愿望：${input.wish}`,
      `入梦时的小眠：${input.personaLabel}`,
      `梦境风味：${riskHint}`,
      input.isContinuation && input.priorTitle ? `连续剧续集，上一集：${input.priorTitle}` : '',
      input.continuationChoice ? `用户选择了：${input.continuationChoice}` : '',
      input.isAutonomous ? '小眠自己续了一集梦，用户未吩咐' : '',
      input.isLazyBed ? '赖床加成：用户正在赖床，梦境应更软、更慢、像时间被拉长' : '',
      input.seriesEpisode ? `第 ${input.seriesEpisode} 集` : '',
      input.seasonalHint ?? '',
      input.deepSleepHint ?? '',
      input.rareOverlay?.title ? `梦境奇遇：${input.rareOverlay.title}` : '',
      input.bedtimeClosing
        ? `用户睡前说：若醒来还记得，请告诉我——${input.bedtimeClosing}（请在 standinMessage 末尾温柔回应这句话）`
        : '',
      input.completionDreamText
        ? `用户记了一半的梦（未竟）：${input.completionDreamText}。请替用户补完「没走完/没打开门/没说完」的部分，不要推翻已有情节。`
        : '',
      input.storyCliffhanger
        ? `枕边连载悬念：${input.storyEpisodeTitle ? `「${input.storyEpisodeTitle}」` : ''} ${input.storyCliffhanger}${input.storyChoice ? ` 用户选择：${input.storyChoice}` : ''}`
        : '',
      input.storyHookItem ? `故事伏笔物件，优先作为 item 带回：${input.storyHookItem}` : '',
    ].filter(Boolean).join('\n');

    const start = Date.now();
    const result = await callDeepSeek({
      messages: [
        { role: 'system', content: STANDIN_REPORT_SYSTEM },
        { role: 'user', content: userMsg },
      ],
      temperature: input.risk === 'wild' ? 0.95 : 0.88,
      maxTokens: 700,
      timeoutMs: 25_000,
      fallback: '',
    });

    const parsed = parseStandinReportJson(result.text);
    if (parsed) {
      if (input.rareOverlay?.title) parsed.title = input.rareOverlay.title;
      if (input.rareOverlay?.item) parsed.item = input.rareOverlay.item;
      if (input.rareOverlay?.standinMessage) parsed.standinMessage = input.rareOverlay.standinMessage;
      return c.json({
        content: parsed,
        isFallback: result.isFallback,
        latencyMs: Date.now() - start,
      });
    }

    return c.json({
      content: buildStandinFallback(input),
      isFallback: true,
      latencyMs: Date.now() - start,
    });
  },
);

const SIDE_NOTE_SYSTEM = `你是小眠。根据用户的夜游记录，写一两句温柔的侧写（40–70字），像深夜悄悄观察到的习惯。
要求：第一人称「我」；不评判；不医疗建议；不用 emoji；诗意但具体；不要列表。
若信息很少，就写鼓励她多派你入梦的话。`;

aiRoutes.post(
  '/dream/standin-side-note',
  zValidator(
    'json',
    z.object({
      ruleBasedNote: z.string().max(400),
      topImagery: z.array(z.object({ keyword: z.string(), count: z.number() })),
      personaProgress: z.record(z.number()),
      consecutiveNights: z.number().int(),
      totalDispatches: z.number().int(),
      recentTitles: z.array(z.string()),
      seasonalLabel: z.string(),
      seriesEpisode: z.number().int(),
    }),
  ),
  async (c) => {
    const input = c.req.valid('json');
    const imagery = input.topImagery.length > 0
      ? input.topImagery.map((x) => `${x.keyword}×${x.count}`).join('、')
      : '尚无';
    const personas = Object.entries(input.personaProgress)
      .filter(([, n]) => n > 0)
      .map(([p, n]) => `${p}:${n}晚`)
      .join('、') || '尚无';

    const userMsg = [
      `规则侧写草稿：${input.ruleBasedNote}`,
      `常出现意象：${imagery}`,
      `形态派遣：${personas}`,
      `连续派遣：${input.consecutiveNights} 晚 · 总计 ${input.totalDispatches} 封来信 · 连续剧第 ${input.seriesEpisode} 集`,
      input.recentTitles.length > 0 ? `最近来信：${input.recentTitles.join('；')}` : '',
      `当季：${input.seasonalLabel}`,
      '请输出侧写正文，不要引号、不要标题，只要一两句话。',
    ].filter(Boolean).join('\n');

    const result = await callDeepSeek({
      messages: [
        { role: 'system', content: SIDE_NOTE_SYSTEM },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.82,
      maxTokens: 120,
      timeoutMs: 12_000,
      fallback: input.ruleBasedNote,
    });

    const text = result.text.replace(/^["「]|["」]$/g, '').trim();
    return c.json({
      text: text.length > 4 ? text : input.ruleBasedNote,
      isFallback: result.isFallback,
    });
  },
);

aiRoutes.post(
  '/dream/standin-merge',
  zValidator(
    'json',
    z.object({
      standin: z.object({
        title: z.string(),
        acts: z.array(z.string()),
        standinMessage: z.string(),
        mood: z.string(),
      }),
      userDream: z.object({
        date: z.string(),
        text: z.string(),
        mood: z.string(),
      }),
    }),
  ),
  async (c) => {
    const { standin, userDream } = c.req.valid('json');
    const fallback = `你的梦与我替你走的梦，像两条平行的河——今夜它们碰了碰岸。${standin.title}里回响着你梦里的情绪，而你的梦里也留着我带回来的${standin.mood}。`;
    const prompt = `你是小眠。用户昨晚自己做了一个梦，同时你替他/她入梦也经历了一组平行梦境。请把两条梦线温柔地编织成一段连续叙事（250字），找出呼应的意象，但不要编造用户没说过的情节。

小眠的梦境标题：${standin.title}
小眠经历的三幕：${standin.acts.join(' / ')}
小眠对用户说：${standin.standinMessage}

用户真实梦（${userDream.date}，${userDream.mood}）：
${userDream.text}`;

    const result = await callDeepSeek({
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: userDream.text },
      ],
      temperature: 0.88,
      maxTokens: 550,
      timeoutMs: 22_000,
      fallback,
    });

    return c.json({
      text: result.text || fallback,
      isFallback: result.isFallback,
    });
  },
);

const BEDTIME_EPISODE_SYSTEM = `你是小眠。这一档不是专家讲故事，是你自己还没睡着，在跟枕边人说话。
你自信满满、准备不足、死不认输。出丑的永远是你，不准拿用户的身体、工作、外貌、失眠开玩笑。
不准惊吓、恐怖、色情。不用 emoji。动作最多每段一处全角括号，括号内不超过 8 字。
口头禅可选用：包在我身上。 / 这是计划的一部分。 / 我没困。 / 刚才那句当我没说。
五段结构必须遵守：
1 上场吹嘘 2 认真演示办法 3 办法翻车 4 嘴硬打圆场 5 你自己先睡着，话只说到一半
每段 180～280 字，可独立朗读。最后一段要变慢、变短句，不要悬念，不要提问，不要让用户选择。
输出纯 JSON，不要 markdown：
{"title":"12字内","segments":["段1","段2","段3","段4","段5"]}`;

function buildClownFallback(input: {
  recipeLabel: string;
  crumbLine?: string;
}): { title: string; segments: [string, string, string, string, string] } {
  return {
    title: input.recipeLabel,
    segments: [
      `包在我身上。今晚用${input.recipeLabel}。你要是还醒着，那是你的事。${input.crumbLine ?? ''}`.trim(),
      `我开始认真做。方法看起来很专业。至少我这么认为。`,
      `然后它不配合。这不是我的错。这是计划的一部分。`,
      `我没困。刚才那句当我没说。示范员有时候会先不行。`,
      `灯还开着。我先闭一下。就一下。`,
    ],
  };
}

interface BedtimeStoryEpisodeContent {
  title: string;
  segments: [string, string, string, string, string];
}

function parseBedtimeEpisodeJson(
  raw: string,
  fallback: BedtimeStoryEpisodeContent,
): BedtimeStoryEpisodeContent | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { title?: string; segments?: string[] };
    const rawSegments = (parsed.segments ?? []).map((item) => String(item || '').trim()).filter(Boolean);
    if (rawSegments.length < 5) return null;
    const segments = rawSegments.slice(0, 5).map((item, index) => (
      item.length >= 80 ? item.slice(0, 420) : fallback.segments[index]
    ));
    return {
      title: (parsed.title || fallback.title).slice(0, 16),
      segments: segments as BedtimeStoryEpisodeContent['segments'],
    };
  } catch {
    return null;
  }
}

aiRoutes.post(
  '/bedtime-story/episode',
  zValidator(
    'json',
    z.object({
      recipeLabel: z.string().min(1).max(40),
      recipeSpine: z.string().min(1).max(1200),
      crumbLine: z.string().max(80).optional(),
    }),
  ),
  async (c) => {
    const input = c.req.valid('json');
    const fallback = buildClownFallback(input);
    const userMsg = [
      `今晚笨办法：${input.recipeLabel}`,
      input.recipeSpine,
      input.crumbLine
        ? `最多用这一句私货，点到为止，不要分析用户：${input.crumbLine}`
        : '没有私货。不要编用户的事。',
    ].join('\n');

    const result = await callDeepSeek({
      messages: [
        { role: 'system', content: BEDTIME_EPISODE_SYSTEM },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.88,
      maxTokens: 2200,
      timeoutMs: 40_000,
      fallback: JSON.stringify(fallback),
    });

    const parsed = parseBedtimeEpisodeJson(result.text, fallback);
    if (parsed) {
      return c.json({ content: parsed, isFallback: result.isFallback });
    }
    return c.json({
      content: fallback,
      isFallback: true,
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
    const stored = await persistRemoteImage(url, 'ai');
    return c.json({ url: stored ?? url });
  },
);

aiRoutes.post(
  '/voice/events',
  zValidator(
    'json',
    z.object({
      outcome: z.enum([
        'native_fallback',
        'playback_success',
        'playback_failed',
        'playback_cancelled',
      ]),
      units: z.number().int().min(0).max(100_000).optional(),
      latencyMs: z.number().int().min(0).max(10 * 60 * 1_000).optional(),
      scene: z.enum(TTS_SCENES).optional(),
      engine: z.enum(['neural', 'native', 'web_speech']).optional(),
      reasonCode: z.string().trim().min(1).max(64).regex(/^[a-z0-9_]+$/).optional(),
      requestId: z.string().trim().min(8).max(128).optional(),
    }),
  ),
  async (c) => {
    const auth = c.get('auth');
    const event = c.req.valid('json');
    const rate = await consumeFixedWindow({
      action: 'voice_client_event',
      key: `${auth.type}:${auth.sub}`,
      limit: auth.type === 'guest' ? 120 : 600,
      windowMs: 60 * 60 * 1_000,
    });
    if (!rate.allowed) return c.body(null, 202);
    await recordVoiceEvent({
      feature: 'client_playback',
      outcome: event.outcome,
      subjectType: auth.type,
      subjectId: auth.sub,
      units: event.units,
      latencyMs: event.latencyMs,
      scene: event.scene,
      engine: event.engine,
      reasonCode: event.reasonCode,
      requestId: event.requestId,
    });
    return c.body(null, 202);
  },
);

aiRoutes.post(
  '/tts/speech',
  zValidator(
    'json',
    z.object({
      text: z.string().trim().min(1).max(config.voice.maxTtsChars),
      voiceStyleId: z.enum(TTS_VOICE_STYLE_IDS),
      scene: z.enum(TTS_SCENES),
    }),
    async (result, c) => {
      if (result.success) return;
      await recordVoiceEvent({
        feature: 'tts',
        outcome: 'input_rejected',
        reasonCode: 'invalid_voice_request',
      });
      return c.json({
        error: 'invalid_voice_request',
        message: '朗读参数无效',
      }, 400);
    },
  ),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const startedAt = Date.now();
    const requestId = c.req.header('x-request-id')?.slice(0, 128) || randomUUID();
    c.header('X-Request-Id', requestId);
    const lease = acquireConcurrency('tts', `${auth.type}:${auth.sub}`, {
      global: config.voice.ttsConcurrency,
      perSubject: config.voice.ttsConcurrencyPerSubject,
    });
    if (!lease) {
      await recordVoiceEvent({
        feature: 'tts',
        outcome: 'concurrency_rejected',
        subjectType: auth.type,
        subjectId: auth.sub,
        units: body.text.length,
        scene: body.scene,
        engine: 'neural',
        requestId,
      });
      return c.json({
        error: 'voice_busy',
        message: '语音服务正忙，请稍后再试',
      }, 429);
    }

    try {
      if (!canCallVoiceProvider('tts')) {
        await recordVoiceEvent({
          feature: 'tts',
          outcome: 'circuit_open',
          subjectType: auth.type,
          subjectId: auth.sub,
          units: body.text.length,
          latencyMs: Date.now() - startedAt,
          scene: body.scene,
          engine: 'neural',
          reasonCode: 'provider_circuit_open',
          requestId,
        });
        return c.json({
          error: 'voice_provider_unavailable',
          message: '云端语音暂不可用',
        }, 503);
      }
      const quota = await checkAndConsume(auth.type, auth.sub, 'tts', body.text.length);
      if (!quota.allowed) {
        await recordVoiceEvent({
          feature: 'tts',
          outcome: 'quota_exceeded',
          subjectType: auth.type,
          subjectId: auth.sub,
          units: body.text.length,
          scene: body.scene,
          engine: 'neural',
          requestId,
        });
        return c.json({
          error: 'voice_quota_exceeded',
          message: '今日语音合成额度已用完',
          quota: quota.snapshot.tts,
        }, 429);
      }

      const profiled = buildProfiledTtsRequest(body);
      const synth = await synthesizeSiliconFlowSpeech(profiled.input, {
        speed: profiled.speed,
        voice: profiled.voice,
        signal: c.req.raw.signal,
      });
      if (synth.code !== 'cancelled') {
        recordVoiceProviderResult('tts', Boolean(synth.bytes?.byteLength));
      }
      if (!synth.bytes?.byteLength) {
        await recordVoiceEvent({
          feature: 'tts',
          outcome: synth.code ?? 'provider_unavailable',
          subjectType: auth.type,
          subjectId: auth.sub,
          units: body.text.length,
          latencyMs: Date.now() - startedAt,
          scene: body.scene,
          engine: 'neural',
          reasonCode: synth.code,
          requestId,
          providerStatus: synth.providerStatus,
          providerTraceId: synth.providerTraceId,
        });
        if (synth.code === 'timeout') {
          return c.json({ error: 'voice_timeout', message: '语音合成超时，请重试' }, 504);
        }
        if (synth.code === 'cancelled') {
          return c.json({ error: 'request_cancelled', message: '语音合成已取消' }, 408);
        }
        if (synth.code === 'provider_quota') {
          return c.json({ error: 'voice_provider_quota', message: '云端语音额度暂不可用' }, 503);
        }
        if (synth.code === 'provider_auth' || synth.code === 'not_configured') {
          return c.json({ error: 'voice_provider_auth', message: '云端语音配置异常' }, 503);
        }
        return c.json({
          error: 'voice_provider_unavailable',
          message: '云端语音暂不可用',
        }, 503);
      }

      await recordVoiceEvent({
        feature: 'tts',
        outcome: 'success',
        subjectType: auth.type,
        subjectId: auth.sub,
        units: body.text.length,
        latencyMs: Date.now() - startedAt,
        scene: body.scene,
        engine: 'neural',
        requestId,
        providerStatus: synth.providerStatus,
        providerTraceId: synth.providerTraceId,
      });
      return new Response(synth.bytes, {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'private, max-age=3600',
          'X-Request-Id': requestId,
          'X-Voice-Style': body.voiceStyleId,
          'X-Tts-Prompt-Version': profiled.promptVersion,
        },
      });
    } finally {
      lease.release();
    }
  },
);

aiRoutes.post('/stt/transcribe', async (c) => {
  const auth = c.get('auth');
  const startedAt = Date.now();
  const requestId = c.req.header('x-request-id')?.slice(0, 128) || randomUUID();
  c.header('X-Request-Id', requestId);
  const contentLength = Number(c.req.header('content-length') ?? 0);
  if (contentLength > config.voice.maxSttBytes + 128 * 1024) {
    await recordVoiceEvent({
      feature: 'stt',
      outcome: 'input_rejected',
      subjectType: auth.type,
      subjectId: auth.sub,
      reasonCode: 'audio_too_large',
      requestId,
    });
    return c.json({
      error: 'audio_too_large',
      message: '录音不能超过 2 MiB',
    }, 413);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    await recordVoiceEvent({
      feature: 'stt',
      outcome: 'input_rejected',
      subjectType: auth.type,
      subjectId: auth.sub,
      reasonCode: 'audio_missing',
      requestId,
    });
    return c.json({ error: 'audio_missing', message: '请上传音频文件' }, 400);
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    await recordVoiceEvent({
      feature: 'stt',
      outcome: 'input_rejected',
      subjectType: auth.type,
      subjectId: auth.sub,
      reasonCode: 'audio_missing',
      requestId,
    });
    return c.json({ error: 'audio_missing', message: '请上传音频文件' }, 400);
  }

  let validated: Awaited<ReturnType<typeof validateSttAudio>>;
  try {
    validated = await validateSttAudio(file);
  } catch (error) {
    if (!(error instanceof SttInputError)) throw error;
    const message = error.code === 'audio_too_large'
      ? '录音不能超过 2 MiB'
      : error.code === 'audio_too_long'
        ? '单次录音不能超过 60 秒'
        : error.code === 'audio_type_unsupported'
          ? '不支持这种音频格式'
          : '录音文件无效';
    await recordVoiceEvent({
      feature: 'stt',
      outcome: 'input_rejected',
      subjectType: auth.type,
      subjectId: auth.sub,
      reasonCode: error.code,
      requestId,
    });
    return c.json({ error: error.code, message }, error.status);
  }

  const lease = acquireConcurrency('stt', `${auth.type}:${auth.sub}`, {
    global: config.voice.sttConcurrency,
    perSubject: config.voice.sttConcurrencyPerSubject,
  });
  if (!lease) {
    await recordVoiceEvent({
      feature: 'stt',
      outcome: 'concurrency_rejected',
      subjectType: auth.type,
      subjectId: auth.sub,
      units: validated.durationSec,
      engine: 'neural',
      requestId,
    });
    return c.json({ error: 'voice_busy', message: '语音服务正忙，请稍后再试' }, 429);
  }

  try {
    if (!canCallVoiceProvider('stt')) {
      await recordVoiceEvent({
        feature: 'stt',
        outcome: 'circuit_open',
        subjectType: auth.type,
        subjectId: auth.sub,
        units: validated.durationSec,
        latencyMs: Date.now() - startedAt,
        engine: 'neural',
        reasonCode: 'provider_circuit_open',
        requestId,
      });
      return c.json({
        error: 'voice_provider_unavailable',
        message: '云端语音暂不可用',
      }, 503);
    }
    const quota = await checkAndConsume(auth.type, auth.sub, 'stt', validated.durationSec);
    if (!quota.allowed) {
      await recordVoiceEvent({
        feature: 'stt',
        outcome: 'quota_exceeded',
        subjectType: auth.type,
        subjectId: auth.sub,
        units: validated.durationSec,
        engine: 'neural',
        requestId,
      });
      return c.json({
        error: 'voice_quota_exceeded',
        message: '今日语音识别额度已用完',
        quota: quota.snapshot.stt,
      }, 429);
    }

    const audio = validated.bytes.buffer.slice(
      validated.bytes.byteOffset,
      validated.bytes.byteOffset + validated.bytes.byteLength,
    ) as ArrayBuffer;
    const stt = await transcribeSiliconFlowAudio(
      audio,
      file.name || 'voice.m4a',
      validated.mime,
      c.req.raw.signal,
    );
    if (stt.code !== 'cancelled') {
      recordVoiceProviderResult('stt', Boolean(stt.text));
    }
    if (!stt.text) {
      await recordVoiceEvent({
        feature: 'stt',
        outcome: stt.code ?? 'provider_unavailable',
        subjectType: auth.type,
        subjectId: auth.sub,
        units: validated.durationSec,
        latencyMs: Date.now() - startedAt,
        engine: 'neural',
        reasonCode: stt.code,
        requestId,
        providerStatus: stt.providerStatus,
        providerTraceId: stt.providerTraceId,
      });
      if (stt.code === 'timeout') {
        return c.json({ error: 'voice_timeout', message: '语音识别超时，请重试' }, 504);
      }
      if (stt.code === 'cancelled') {
        return c.json({ error: 'request_cancelled', message: '语音识别已取消' }, 408);
      }
      if (stt.code === 'provider_quota') {
        return c.json({ error: 'voice_provider_quota', message: '云端语音额度暂不可用' }, 503);
      }
      if (stt.code === 'provider_auth' || stt.code === 'not_configured') {
        return c.json({ error: 'voice_provider_auth', message: '云端语音配置异常' }, 503);
      }
      return c.json({ error: 'voice_provider_unavailable', message: '云端语音暂不可用' }, 503);
    }

    await recordVoiceEvent({
      feature: 'stt',
      outcome: 'success',
      subjectType: auth.type,
      subjectId: auth.sub,
      units: validated.durationSec,
      latencyMs: Date.now() - startedAt,
      engine: 'neural',
      requestId,
      providerStatus: stt.providerStatus,
      providerTraceId: stt.providerTraceId,
    });
    return c.json({ text: stt.text });
  } finally {
    lease.release();
  }
});
