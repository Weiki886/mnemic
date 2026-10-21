import { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { ChatReply } from "@mnemic/shared";
import type { ChatSession } from "./chat-session.js";
import { chatFailure, formatReply, renderAnswerChunks, terminalText } from "./presentation.js";
import { completeSlash, parseChatInput, slashHelp } from "./slash-commands.js";
import { runMemoryCommand, type MemoryApi } from "./memory-commands.js";

interface Block {
  id: number;
  label: string;
  text: string;
  color: "cyan" | "white" | "gray" | "red" | "yellow";
}

export function ChatApp({
  session,
  memoryApi,
  onDone,
}: {
  session: ChatSession;
  memoryApi: MemoryApi;
  onDone: (code: number) => void;
}) {
  const { exit } = useApp();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [input, setInput] = useState("");
  const [inputVersion, setInputVersion] = useState(0);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [closing, setClosing] = useState(false);
  const [preview, setPreview] = useState<ChatReply | null>(null);
  const [partial, setPartial] = useState("");
  const busyRef = useRef(true);
  const closingRef = useRef(false);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const pendingMemory = useRef<Promise<string> | undefined>(undefined);
  const append = (label: string, text: string, color: Block["color"]) => {
    if (mounted.current) {
      const block = { id: sequence.current++, label, text: terminalText(text, true), color };
      setBlocks((items) => [...items, block]);
    }
  };
  const appendHistory = () => {
    for (const m of session.history)
      append(
        `历史 · ${m.speaker === "user" ? "用户" : m.speaker === "tool" ? "工具" : "助手"}`,
        formatReply({
          message_id: m.id,
          answer: m.raw_text,
          memories: m.memories ?? [],
          abstained: false,
        }),
        "gray",
      );
  };

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        const row = await session.start();
        appendHistory();
        if (mounted.current) setId(row.id);
      } catch (error) {
        append("错误", chatFailure(error), "red");
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, [session]);

  const finish = async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    let code = 0;
    try {
      // /forget 也可能已有写副作用；退出要先等待确认，不丢弃或重发请求。
      await pendingMemory.current?.catch(() => {});
      await session.close();
      append("会话已提交", "记忆提取在后台完成，提交不等于已完成索引。", "gray");
    } catch (error) {
      code = 1;
      append("提交未确认", chatFailure(error), "red");
    }
    onDone(code);
    exit();
  };
  useInput((value, key) => {
    if (key.ctrl && value === "c") void finish();
    else if (
      key.tab &&
      !key.shift &&
      !key.ctrl &&
      !key.meta &&
      !busyRef.current &&
      !closingRef.current
    ) {
      const completion = completeSlash(input);
      setCandidates(completion.candidates.length > 1 ? completion.candidates : []);
      if (completion.value !== input) {
        setInput(completion.value);
        // TextInput 没有受控光标 API；补全后重建，把光标放到新增参数空格之后。
        setInputVersion((version) => version + 1);
      }
    }
  });

  const submit = async (text: string) => {
    if (busyRef.current || closingRef.current) return;
    const parsed = parseChatInput(text);
    if (parsed.kind === "empty") return;
    setCandidates([]);
    if (parsed.kind === "error") {
      append("命令无效", parsed.message, "red");
      return;
    }
    if (parsed.kind === "command" && parsed.name === "help") {
      setInput("");
      append("本地命令帮助", slashHelp(), "gray");
      return;
    }
    if (parsed.kind === "command" && parsed.name === "exit") {
      await finish();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setInput("");
    try {
      if (parsed.kind === "command" && parsed.name === "new") {
        const row = await session.newConversation();
        if (mounted.current) setId(row.id);
        append("新会话", "旧会话已提交；后台记忆提取可能仍在处理。", "gray");
      } else if (parsed.kind === "command" && parsed.name === "resume") {
        const row = await session.resume(parsed.argument);
        if (mounted.current) setId(row.id);
        append("续聊会话", "已引用目标会话历史；原会话与切换前会话保持只读。", "gray");
        appendHistory();
      } else if (
        parsed.kind === "command" &&
        (parsed.name === "memory" || parsed.name === "forget")
      ) {
        const job = runMemoryCommand(memoryApi, session.projectId, parsed);
        pendingMemory.current = job;
        append("记忆", await job, "gray");
      } else if (parsed.kind === "message") {
        append("你", text, "cyan");
        const reply = await session.send(text);
        if (!mounted.current || closingRef.current) return;
        setId(session.id);
        setPreview(reply);
        await renderAnswerChunks(reply.answer, (chunk) => {
          if (mounted.current && !closingRef.current) setPartial(chunk);
        });
        append("回答", formatReply(reply), reply.abstained ? "yellow" : "white");
      }
    } catch (error) {
      append("错误", chatFailure(error), "red");
    } finally {
      pendingMemory.current = undefined;
      busyRef.current = false;
      if (mounted.current) {
        setBusy(false);
        setPreview(null);
        setPartial("");
      }
    }
  };

  return (
    <Box flexDirection="column">
      <Static items={blocks}>
        {(block) => (
          <Box key={block.id} flexDirection="column" marginBottom={1}>
            <Text color={block.color} bold>
              {block.label}
            </Text>
            <Text>{block.text}</Text>
          </Box>
        )}
      </Static>
      <Text color="cyan" bold>
        Mnemic · 项目 {session.projectId}
      </Text>
      <Text dimColor>
        会话 {id ?? "未创建"} · /new 新会话 · /resume UUID 续聊 · /exit 提交退出 · Ctrl+C
        等待请求后退出
      </Text>
      <Text dimColor>对话将调用服务端模型，可能计费。回答收到后按段显示。</Text>
      <Text dimColor>/help 命令帮助 · Tab 补全命令名（不执行）</Text>
      {candidates.length > 0 && <Text dimColor>候选：{candidates.join(" ")}</Text>}
      {preview && <Text>{formatReply(preview, partial)}</Text>}
      {(busy || closing) && (
        <Text color="yellow">{closing ? "等待请求结束并提交退出…" : "处理中…"}</Text>
      )}
      <Box>
        <Text color="cyan">{"> "}</Text>
        <TextInput
          key={inputVersion}
          value={input}
          focus={!busy && !closing}
          onChange={(value) => {
            setCandidates([]);
            setInput(terminalText(value));
          }}
          onSubmit={(value) => {
            void submit(value);
          }}
        />
      </Box>
    </Box>
  );
}
