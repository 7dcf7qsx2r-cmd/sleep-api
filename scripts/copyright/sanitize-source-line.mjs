/**
 * 软著源程序导出专用：对鉴别材料中的代码行做中性化替换（不修改仓库源码）
 */

const LINE_REPLACEMENTS = [
  [/deepseekApiKey/g, 'cloudDialogApiKey'],
  [/deepseekApiUrl/g, 'cloudDialogApiUrl'],
  [/deepseekModel/g, 'cloudDialogModel'],
  [/siliconflowApiKey/g, 'cloudSpeechApiKey'],
  [/DeepSeek/g, 'CloudDialog'],
  [/deepseek-chat/g, 'cloud-dialog'],
  [/deepseek\.com/g, 'cloud-dialog.example.com'],
  [/SiliconFlow/g, 'CloudSpeech'],
  [/siliconflow\.cn/g, 'cloud-speech.example.com'],
  [/siliconflow/g, 'cloudspeech'],
  [/SILICONFLOW/g, 'CLOUDSPEECH'],
  [/FunAudioLLM/g, 'FunAudio'],
  [/getAIReply/g, 'getCompanionReply'],
  [/chatWithXiaoMian/g, 'chatWithCompanion'],
  [/aiClient/g, 'companionClient'],
  [/AIClient/g, 'CompanionClient'],
  [/睡眠陪伴AI/g, '睡眠陪伴角色'],
  [/AI绘画/g, '绘画'],
  [/大语言模型/g, '云端对话服务'],
  [/大模型/g, '云端对话'],
  [/OpenAI/g, 'CloudProvider'],
  [/ChatGPT/g, 'CloudChat'],
  [/Copilot/g, 'Assistant'],
  [/Claude/g, 'CloudChat'],
  [/你是「小眠」，一个温柔的睡眠陪伴AI/g, '你是「小眠」，睡眠陪伴角色'],
  [/AI 对话/g, '文字对话'],
  [/AI对话/g, '文字对话'],
  [/AI 生成/g, '系统生成'],
  [/AI生成/g, '系统生成'],
  [/AI 助眠/g, '助眠提示'],
  [/AI助眠/g, '助眠提示'],
  [/AI 虚拟/g, '虚拟'],
  [/集成大语言/g, '集成云端对话'],
  [/LLM 润色/g, '云端润色'],
  [/LLM润色/g, '云端润色'],
  [/'llm'/g, "'model'"],
  [/source: 'llm'/g, "source: 'model'"],
  [/EXPO_PUBLIC_DEEPSEEK_API_KEY/g, 'EXPO_PUBLIC_CLOUD_DIALOG_KEY'],
  [/EXPO_PUBLIC_SILICONFLOW_API_KEY/g, 'EXPO_PUBLIC_CLOUD_SPEECH_KEY'],
  [/DEEPSEEK_API_KEY/g, 'CLOUD_DIALOG_KEY'],
  [/DEEPSEEK_API_URL/g, 'CLOUD_DIALOG_URL'],
  [/DEEPSEEK_MODEL/g, 'CLOUD_DIALOG_MODEL'],
  [/SILICONFLOW_API_KEY/g, 'CLOUD_SPEECH_KEY'],
  [/SILICONFLOW_IMAGE_URL/g, 'CLOUD_IMAGE_URL'],
  [/callDeepSeek/g, 'callCloudDialog'],
  [/generateSiliconFlowImage/g, 'generateCloudImage'],
  [/synthesizeSiliconFlowSpeech/g, 'synthesizeCloudSpeech'],
  [/fetchSiliconFlowSpeechStream/g, 'fetchCloudSpeechStream'],
  [/transcribeSiliconFlowAudio/g, 'transcribeCloudAudio'],
  [/fetchDirectSiliconFlow/g, 'fetchDirectCloudSpeech'],
  [/XIAOMIAN_SYSTEM_PROMPT/g, 'XIAOMIAN_ROLE_PROMPT'],
  [/AI routes/g, '对话路由'],
  [/AI 路由/g, '对话路由'],
  [/console\.warn\('\[小眠AI\]/g, "console.warn('[小眠]"],
  [/console\.warn\("\[小眠AI\]/g, 'console.warn("[小眠]'],
];

const PATH_REPLACEMENTS = [
  [/aiClient\.ts/g, 'companionClient.ts'],
  [/aiClient/g, 'companionClient'],
  [/deepseek\.js/g, 'cloudDialog.js'],
  [/siliconflow/g, 'cloudspeech'],
];

export function sanitizeCopyrightLine(line) {
  let out = line;
  for (const [pattern, replacement] of LINE_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function sanitizeCopyrightPath(filePath) {
  let out = filePath;
  for (const [pattern, replacement] of PATH_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
