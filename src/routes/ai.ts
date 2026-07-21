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
import { ownerFromAuth } from '../lib/owner.js';
import { loadSleepNights } from '../services/sleepNights.js';
import { generateHomeDailyInsight } from '../services/homeInsight.js';

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

aiRoutes.post(
  '/chat',
  zValidator(
    'json',
    z.object({
      message: z.string().min(1).max(4000),
      history: historySchema.optional(),
      systemPrompt: z.string().max(8000).optional(),
      personaContext: z.string().max(4000).optional(),
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
      maxTokens: body.maxTokens ?? 500,
      timeoutMs: 25_000,
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

const BEDTIME_EPISODE_SYSTEM = `你是小眠，枕边连载的讲述者。为用户写「入眠连续剧」的一集，必须极慢、极轻、为闭眼设计。
输出纯 JSON，不要 markdown：
{
  "title": "本集标题，12字内",
  "segments": ["段1 25-40字", "段2", "段3", "段4", "段5"],
  "cliffhanger": "悬念一句，40字内，留给梦与明早来信",
  "choice": { "a": "安静选项A 12字内", "b": "安静选项B 12字内" },
  "standinWish": "若用户让小眠入梦续写，委托句 30字内",
  "bedtimeClosing": "若醒来还记得请告诉我… 的回应句 20字内",
  "hookItem": "明早可能带回的陈列室物件名，须简短"
}
要求：5段每段独立可朗读；不刺激、不恐怖；与上集悬念衔接；choice 两个选项都温柔。`;

interface BedtimeStoryEpisodeContent {
  title: string;
  segments: [string, string, string, string, string];
  cliffhanger: string;
  choice: { a: string; b: string };
  standinWish: string;
  bedtimeClosing: string;
  hookItem: string;
}

function buildEpisodeFallback(input: {
  worldLabel: string;
  episodeNum: number;
}): BedtimeStoryEpisodeContent {
  const w = input.worldLabel;
  return {
    title: `第${input.episodeNum}夜 · ${w}`,
    segments: [
      `在${w}，夜比别处慢半拍。`,
      '风停了，像怕惊扰什么。',
      '小眠走在你前面半步，脚步很轻。',
      '远处有光，不刺眼，只是等着。',
      '你不必赶到那里，光会自己靠近。',
    ],
    cliffhanger: '门缝里有微光，小眠说她会替你去看一眼。',
    choice: { a: '留在原地等', b: '跟着光走' },
    standinWish: `替我去${w}看看那道光后面是什么`,
    bedtimeClosing: '光是否还在',
    hookItem: '一缕月光',
  };
}

function parseBedtimeEpisodeJson(raw: string): BedtimeStoryEpisodeContent | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const p = JSON.parse(match[0]) as Partial<BedtimeStoryEpisodeContent> & { segments?: string[] };
    const segments = (p.segments ?? []).filter(Boolean).slice(0, 5);
    while (segments.length < 5) segments.push('夜更深了，呼吸更慢。');
    if (!p.cliffhanger || !p.choice?.a || !p.choice?.b) return null;
    return {
      title: (p.title || '枕边一夜').slice(0, 20),
      segments: segments as BedtimeStoryEpisodeContent['segments'],
      cliffhanger: p.cliffhanger.slice(0, 60),
      choice: { a: p.choice.a.slice(0, 20), b: p.choice.b.slice(0, 20) },
      standinWish: (p.standinWish || '替我把悬念走完').slice(0, 50),
      bedtimeClosing: (p.bedtimeClosing || '后面怎样了').slice(0, 30),
      hookItem: (p.hookItem || '一枚温热的石子').slice(0, 20),
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
      worldLabel: z.string().min(1).max(40),
      worldSetting: z.string().min(1).max(400),
      episodeNum: z.number().int().min(1).max(99),
      contextBlock: z.string().max(2000),
      customTheme: z.string().max(200).optional(),
    }),
  ),
  async (c) => {
    const input = c.req.valid('json');
    const userMsg = [
      `世界观：${input.worldLabel}`,
      input.customTheme ? `自定义主题：${input.customTheme}` : input.worldSetting,
      input.contextBlock,
    ].join('\n');

    const result = await callDeepSeek({
      messages: [
        { role: 'system', content: BEDTIME_EPISODE_SYSTEM },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.92,
      maxTokens: 750,
      timeoutMs: 28_000,
      fallback: '',
    });

    const parsed = parseBedtimeEpisodeJson(result.text);
    if (parsed) {
      return c.json({ content: parsed, isFallback: result.isFallback });
    }
    return c.json({
      content: buildEpisodeFallback(input),
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
    const synth = await synthesizeSiliconFlowSpeech(body.input, {
      speed: body.speed,
      voice: body.voice,
      gain: body.gain,
    });
    if (!synth.bytes?.byteLength) {
      return c.json({
        error: 'tts_failed',
        message: synth.reason ?? '语音合成不可用，请检查 SILICONFLOW_API_KEY',
      }, 503);
    }
    return new Response(synth.bytes, {
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
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'no_file', message: '请上传音频文件' }, 400);
  }
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
