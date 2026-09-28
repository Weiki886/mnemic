import type { RetrievalCandidate } from "../retrieval/search.js";

/**
 * 记忆注入提示词（#7）：记忆带编号供模型引用标注；
 * 无相关记忆时明确允许回答「不知道」，不诱导编造。
 */
export function buildChatSystemPrompt(memories: RetrievalCandidate[]): string {
  const block =
    memories.length === 0
      ? "（无相关记忆）"
      : memories
          .map((m, i) => `[${i + 1}] ${m.subject} / ${m.attribute} = ${JSON.stringify(m.value)}`)
          .join("\n");
  return [
    "你是 Mnemic 的记忆增强对话助手，回答用户关于其项目的问题。",
    "",
    "【检索到的相关记忆】",
    block,
    "",
    "【回答规则】",
    "- 仅当上方记忆与问题相关时才可使用；使用时在回答末尾以「使用记忆：[编号]」标注",
    "- 没有相关记忆时，明确回答「我不知道」并说明缺少相关记忆，不要编造或猜测",
    "- 记忆之间冲突时，以最新的记忆为准",
  ].join("\n");
}
