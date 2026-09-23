/**
 * 提取 prompt（#4）：推理模型会忽略 API 层注入的 schema（spike ① 关键发现），
 * 必须以文本形式写进 prompt；输出为 JSON 数组（无可记内容时输出 []）。
 */

const SCHEMA_TEXT = `{
  "type": "fact" | "preference" | "decision" | "progress",
  "subject": string, "attribute": string, "value": string,
  "valid_time": "ISO 8601 或模糊时间原文",
  "time_precision": "DAY" | "WEEK" | "MONTH" | "FUZZY",
  "time_confidence": 0~1,
  "assertion_intent": "ASSERT" | "UPDATE" | "CORRECT" | "RETRACT",
  "source_type": "USER_CORRECTION" | "USER_EXPLICIT" | "PROJECT_FILE" | "TOOL_OBSERVATION" | "DOCUMENT" | "WEB_CONTENT" | "AGENT_INFERENCE",
  "importance": 0~1, "confidence": 0~1,
  "entities": string[], "is_profile": boolean
}`;

export function buildExtractionPrompt(input: string, today: string, feedback?: string): string {
  return (
    `从下面的用户话语中提取记忆候选，输出 json 数组（每条话语 0~N 条，没有可记内容输出 []）。今天是 ${today}。\n` +
    `数组元素必须符合以下 schema（不要输出任何其他内容）：\n${SCHEMA_TEXT}\n` +
    `断言意图判断：普通陈述=ASSERT，"改用/换成/以后都用"=UPDATE，"说错了/不对，应该是"=CORRECT，"当我没说过/作废"=RETRACT。\n` +
    `时间精度判断：明确到日（昨天/今天/X月X日/三天前）=DAY；周粒度（上周/这周/上上周）=WEEK；月粒度（上个月/这个月/X年X月）=MONTH；无法定位（最近/之前/以后）=FUZZY。time_confidence 随模糊度下降。\n` +
    `source_type 判断：用户纠正=USER_CORRECTION，用户明确陈述=USER_EXPLICIT，项目文件内容=PROJECT_FILE，工具观测=TOOL_OBSERVATION，文档=DOCUMENT，网络内容=WEB_CONTENT，助手推断=AGENT_INFERENCE。\n` +
    `是否画像类（is_profile）：技术栈/进度/未决问题类为 true。\n` +
    (feedback ? `\n上次输出不合法：${feedback}\n请仅输出修正后的 JSON 数组。\n` : "") +
    `\n用户话语：${input}`
  );
}
