import { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import { ChatStreamReadError } from "@mnemic/shared/chat-stream";
import { SessionStreamError, type ChatSession } from "./chat-session.js";
import { chatFailure, formatReply, terminalText } from "./presentation.js";
import { completeSlash, parseChatInput, slashHelp } from "./slash-commands.js";
import {
  runMemoryCommand,
  runRecallCommand,
  type MemoryApi,
  type RecallApi,
} from "./memory-commands.js";
import { editLine, type LineState } from "./line-input.js";
import { runManagementCommand, type ManagementApi } from "./management-commands.js";
import type { ApprovalController } from "./approval-controller.js";

interface Block {
  id: number;
  label: string;
  text: string;
  color: "cyan" | "white" | "gray" | "red" | "yellow";
}

export function ChatApp({
  session,
  memoryApi,
  approval,
  onDone,
}: {
  session: ChatSession;
  memoryApi: MemoryApi & RecallApi & ManagementApi;
  approval?: ApprovalController;
  onDone: (code: number) => void;
}) {
  const { exit } = useApp();
  const { write } = useStdout();
  const [, setApprovalVersion] = useState(0);
  useEffect(() => approval?.subscribe(() => setApprovalVersion((v) => v + 1)), [approval]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [line, setLine] = useState<LineState>({ text: "", cursor: 0 });
  const lineRef = useRef(line);
  const updateLine = (next: LineState) => {
    lineRef.current = next;
    setLine(next);
  };
  const setInput = (value: string) => {
    updateLine({ text: value, cursor: Array.from(value).length });
  };
  const [candidates, setCandidates] = useState<string[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [closing, setClosing] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [partial, setPartial] = useState("");
  const busyRef = useRef(true);
  const closingRef = useRef(false);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const pendingCommand = useRef<Promise<string> | undefined>(undefined);
  const append = (label: string, text: string, color: Block["color"]) => {
    if (mounted.current) {
      const block = { id: sequence.current++, label, text: terminalText(text, true), color };
      setBlocks((items) => [...items, block]);
    }
  };
  const appendHistory = () => {
    for (const m of session.history)
      append(
        `历史 · ${m.speaker === "user" ? "用户" : m.speaker === "tool" ? "工具" : "助手"}${m.generation_status === "interrupted" ? " · 已中断" : m.generation_status === "failed" ? " · 生成失败" : ""}`,
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
        approval?.setSession(row.id);
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
      session.interrupt();
      approval?.dispose();
    };
  }, [session, approval]);

  const finish = async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    approval?.dispose();
    setClosing(true);
    let code = 0;
    try {
      // /forget、/recall 可能已写入状态/trace 或计费；等待确认，不重发。
      await pendingCommand.current?.catch(() => {});
      await session.close();
      append("会话已提交", "记忆提取在后台完成，提交不等于已完成索引。", "gray");
    } catch (error) {
      code = 1;
      // A queued React block may never render after exit(); emit the final diagnostic directly.
      write(`提交未确认\n${terminalText(chatFailure(error), true)}\n`);
    }
    onDone(code);
    exit();
  };
  useInput((value, key) => {
    const prompt = approval?.pending;
    if (prompt) {
      if (prompt.answering) return;
      const choice =
        key.escape || (key.ctrl && value === "c") || value === "n"
          ? "deny"
          : value === "1"
            ? "once"
            : value === "2"
              ? "session"
              : value === "3"
                ? "permanent"
                : null;
      if (choice) void approval!.answer(prompt.id, choice);
      return;
    }
    if (approval?.busy) return;
    if ((key.escape || (key.ctrl && value === "c")) && session.generating) {
      session.interrupt();
      setCancelling(true);
      return;
    }
    if (key.ctrl && value === "c") {
      void finish();
      return;
    }
    if (busyRef.current || closingRef.current) return;
    if (key.tab && !key.shift && !key.ctrl && !key.meta) {
      const completion = completeSlash(lineRef.current.text);
      setCandidates(completion.candidates.length > 1 ? completion.candidates : []);
      if (completion.value !== lineRef.current.text) setInput(completion.value);
    } else if (key.return) {
      void submit(lineRef.current.text);
    } else {
      const next = editLine(lineRef.current, terminalText(value), key);
      if (next !== lineRef.current) {
        setCandidates([]);
        updateLine(next);
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
        approval?.setSession(row.id);
        if (mounted.current) setId(row.id);
        append("新会话", "旧会话已提交；后台记忆提取可能仍在处理。", "gray");
      } else if (parsed.kind === "command" && parsed.name === "resume") {
        const row = await session.resume(parsed.argument);
        approval?.setSession(row.id);
        if (mounted.current) setId(row.id);
        append("续聊会话", "已引用目标会话历史；原会话与切换前会话保持只读。", "gray");
        appendHistory();
      } else if (parsed.kind === "command" && parsed.name === "permissions") {
        if (!approval) throw new Error("审批控制器未初始化。");
        if (parsed.action === "mode") approval.setMode(parsed.mode);
        if (parsed.action === "revoke") {
          append(
            "权限",
            (await approval.revoke(parsed.id)) ? "授权已撤销。" : "当前项目未找到此授权。",
            "gray",
          );
        } else if (parsed.action === "list") {
          const rows = await approval.list();
          append(
            "权限授权",
            rows.length
              ? rows
                  .map(
                    (row) =>
                      `${row.id} ${row.grant.scope} ${row.grant.operation} ${row.grant.target}`,
                  )
                  .join("\n")
              : "无可复用授权。",
            "gray",
          );
        } else
          append(
            "权限",
            `${approval.mode} · ${approval.root}\n仅控制未来文件/命令 Tools，当前没有执行器。`,
            "gray",
          );
      } else if (
        parsed.kind === "command" &&
        (parsed.name === "status" || parsed.name === "config")
      ) {
        const job = runManagementCommand(memoryApi, session.projectId, session.id, parsed);
        pendingCommand.current = job;
        append(parsed.name === "status" ? "状态" : "配置", await job, "gray");
      } else if (
        parsed.kind === "command" &&
        (parsed.name === "memory" || parsed.name === "forget" || parsed.name === "recall")
      ) {
        const job =
          parsed.name === "recall"
            ? runRecallCommand(memoryApi, session.projectId, parsed.query)
            : runMemoryCommand(memoryApi, session.projectId, parsed);
        pendingCommand.current = job;
        append(parsed.name === "recall" ? "手动召回" : "记忆", await job, "gray");
      } else if (parsed.kind === "message") {
        append("你", text, "cyan");
        setStreaming(true);
        const reply = await session.send(text, (event) => {
          if (event.type === "delta") {
            const chunk = terminalText(event.text, true);
            if (mounted.current) setPartial((answer) => answer + chunk);
          }
        });
        if (!mounted.current || closingRef.current) return;
        setId(session.id);
        append(
          reply.generation_status === "interrupted" ? "已中断 · 已保存" : "回答",
          formatReply(reply),
          reply.abstained ? "yellow" : "white",
        );
      }
    } catch (error) {
      if (error instanceof ChatStreamReadError) {
        const failed =
          error.progress.terminal?.type === "error" &&
          error.progress.terminal.code === "GENERATION_FAILED";
        append(
          failed
            ? "生成失败 · 已保存片段"
            : error instanceof SessionStreamError && error.saved
              ? "已保存 · 输出未完成"
              : "保存未确认",
          error.progress.answer || "未收到回答片段；不会自动重发。",
          "yellow",
        );
      }
      append("错误", chatFailure(error), "red");
    } finally {
      pendingCommand.current = undefined;
      busyRef.current = false;
      if (mounted.current) {
        setBusy(false);
        setStreaming(false);
        setCancelling(false);
        setPartial("");
      }
    }
  };

  const chars = Array.from(line.text);
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
        生成中打断，空闲时提交退出
      </Text>
      <Text dimColor>实时流式回答，可能计费。ESC / Ctrl+C 中断后等待保存确认，可继续对话。</Text>
      <Text dimColor>/help 命令帮助 · Tab 补全命令名（不执行）</Text>
      {approval && (
        <Text dimColor>
          权限 {approval.mode} · 项目根 {terminalText(approval.root)}
        </Text>
      )}
      {approval?.pending && (
        <Box flexDirection="column">
          <Text color="yellow" bold>
            审批确认 · {approval.pending.evaluation.operation}
          </Text>
          <Text>{terminalText(approval.pending.evaluation.target)}</Text>
          {approval.pending.command && (
            <Text>{terminalText(JSON.stringify(approval.pending.command))}</Text>
          )}
          <Text>
            {approval.pending.answering
              ? "正在复核并保存选择…"
              : `1 单次${approval.pending.evaluation.allowed_scopes.includes("session") ? " · 2 本会话" : ""}${approval.pending.evaluation.allowed_scopes.includes("permanent") ? " · 3 永久" : ""} · n / ESC / Ctrl+C 拒绝；Enter 不确认`}
          </Text>
        </Box>
      )}
      {candidates.length > 0 && <Text dimColor>候选：{candidates.join(" ")}</Text>}
      {streaming && partial && <Text>{partial}</Text>}
      {(busy || closing) && (
        <Text color="yellow">
          {closing
            ? "等待请求结束并提交退出…"
            : cancelling
              ? "处理中：正在请求中断并等待保存确认…"
              : "处理中…"}
        </Text>
      )}
      <Box>
        <Text color="cyan">{"> "}</Text>
        <Text>
          {chars.slice(0, line.cursor).join("")}
          {!busy && !closing ? (
            <Text inverse>{chars[line.cursor] ?? " "}</Text>
          ) : (
            (chars[line.cursor] ?? "")
          )}
          {chars.slice(line.cursor + 1).join("")}
        </Text>
      </Box>
    </Box>
  );
}
