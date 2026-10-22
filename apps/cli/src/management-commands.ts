import { ApiError, type ApiClient, type ServerConfig } from "@mnemic/shared";
import {
  ConfigSchema,
  ProjectStatusSchema,
  ProviderConfigSchema,
  ProviderPatchSchema,
} from "@mnemic/shared/management";
import { ForgetResultSchema } from "@mnemic/shared/memory";
import { SessionError } from "./chat-session.js";
import { terminalText } from "./presentation.js";
import type { ManagementCommand } from "./slash-commands.js";
export type ManagementApi = Pick<ApiClient, "getProjectStatus" | "getConfig" | "updateProvider">;
function slotsText(slots: ServerConfig["slots"]): string {
  return (["chat", "extraction", "embedding"] as const)
    .map((name) => {
      const s = slots[name];
      return `${name}: ${s ? `${s.provider_name} (${s.provider_id}) / ${s.model}` : "未配置"}`;
    })
    .join("\n");
}
export async function runManagementCommand(
  api: ManagementApi,
  projectId: string,
  conversationId: string,
  command: ManagementCommand,
): Promise<string> {
  try {
    if (command.name === "status") {
      const project = ForgetResultSchema.shape.id.parse(projectId),
        conversation = ForgetResultSchema.shape.id.parse(conversationId);
      const status = ProjectStatusSchema.parse(await api.getProjectStatus(project, conversation));
      if (status.project.id !== project || status.conversation.id !== conversation)
        throw new Error("status scope");
      return terminalText(
        `项目 ${status.project.id} · ${status.project.name}\n会话 ${status.conversation.id} · ${status.conversation.ended_at ? "已提交" : "进行中"}\n${Object.entries(
          status.counts,
        )
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}\n生效配置（不等于模型已连通）：\n${slotsText(status.slots)}`,
        true,
      );
    }
    if (command.action === "show") {
      const config = ConfigSchema.parse(await api.getConfig());
      const providers = config.providers.map(
        (p) =>
          `${p.id} · ${p.name} · ${p.protocol}\n  ${p.base_url ?? "端点不可显示"}\n  ${Object.entries(
            p.models,
          )
            .map(([s, m]) => `${s}=${m}`)
            .join(" ")}`,
      );
      return terminalText(
        `全局服务端配置（非项目配置）；当前优先级为最早创建的已配置槽位 Provider，时间相同按 ID。\n${slotsText(config.slots)}\n${providers.length ? providers.join("\n") : "暂无 Provider"}\n不显示密钥、不探测模型；修改影响全局后续请求，embedding 切换需 REEMBED。`,
        true,
      );
    }
    const id = ForgetResultSchema.shape.id.parse(command.id),
      patch = ProviderPatchSchema.parse(command.patch);
    const updated = ProviderConfigSchema.parse(await api.updateProvider(id, patch));
    if (
      updated.id !== id ||
      (["name", "protocol", "base_url"] as const).some(
        (k) => patch[k] !== undefined && patch[k] !== updated[k],
      ) ||
      Object.entries(patch.models ?? {}).some(
        ([slot, model]) => updated.models[slot as "chat" | "extraction"] !== model,
      )
    )
      throw new Error("patch not confirmed");
    return terminalText(
      `全局配置修改已确认：${updated.id} · ${updated.name}。后续模型解析使用新配置；未探测模型，已解析的调用不切换。用 /config 核对生效槽位。`,
    );
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401 || error.status === 403)
        throw new SessionError("鉴权被拒绝，请检查 MNEMIC_AUTH_TOKEN");
      if (error.status === 404)
        throw new SessionError("当前项目/会话/Provider 不存在，或服务端版本不支持");
      if (error.status === 409)
        throw new SessionError("配置冲突：请检查名称占用或 embedding REEMBED 限制；未自动重试");
    }
    throw new SessionError(
      command.name === "config" && command.action === "set"
        ? "配置修改未确认；请先 /config 核对，未自动重试"
        : "状态/配置读取失败、超时或响应不兼容",
    );
  }
}
