<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from "vue";
import type { ApiClient } from "@mnemic/shared";
import { UsageQuerySchema, UsageReportSchema, type UsageReport } from "@mnemic/shared/usage";

const props = defineProps<{ projectId: string; api: Pick<ApiClient, "getUsageReport"> }>();
const from = ref(""),
  to = ref(""),
  conversation = ref(""),
  group = ref("day");
const report = shallowRef<UsageReport | null>(null),
  loading = ref(false),
  error = ref("");
const metrics = [
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "reasoning_tokens",
  "cached_input_tokens",
] as const;
let request = 0;
onBeforeUnmount(() => {
  request++;
});
async function load() {
  const current = ++request;
  report.value = null;
  error.value = "";
  loading.value = false;
  const query = UsageQuerySchema.safeParse({
    group_by: group.value,
    ...(from.value.trim() ? { from: from.value.trim() } : {}),
    ...(to.value.trim() ? { to: to.value.trim() } : {}),
    ...(conversation.value.trim() ? { conversation_id: conversation.value.trim() } : {}),
  });
  const project = UsageReportSchema.shape.project_id.safeParse(props.projectId);
  if (!query.success || !project.success) {
    error.value = "查询参数无效：请填写 ISO 时间、合法会话 UUID 和分组方式";
    return;
  }
  loading.value = true;
  try {
    const r = UsageReportSchema.parse(await props.api.getUsageReport(project.data, query.data));
    if (current !== request) return;
    if (
      r.project_id !== project.data ||
      r.conversation_id !== (query.data.conversation_id ?? null) ||
      r.group_by !== query.data.group_by ||
      (query.data.from && Date.parse(query.data.from) !== Date.parse(r.from)) ||
      (query.data.to && Date.parse(query.data.to) !== Date.parse(r.to))
    )
      throw new Error("usage scope mismatch");
    report.value = r;
  } catch {
    if (current === request)
      error.value = "用量加载失败：请检查 Token、项目/会话、时间范围和服务端版本";
  } finally {
    if (current === request) loading.value = false;
  }
}
watch(
  () => [props.projectId, props.api] as const,
  (_value, old) => {
    if (old && old[0] !== props.projectId) conversation.value = "";
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <section class="space-y-6">
    <header>
      <p class="font-mono text-xs uppercase tracking-widest text-record-600">Model usage</p>
      <h1 class="mt-2 text-2xl font-semibold tracking-tight">用量与估价</h1>
      <p class="mt-2 text-sm text-zinc-600">
        只读取当前项目的调用记录，不触发模型请求。估价非账单，未报告不等于零；后台写回可能稍后补齐。
      </p>
    </header>
    <form
      class="grid gap-3 rounded-xl border border-zinc-200 bg-white p-5 sm:grid-cols-2"
      @submit.prevent="load"
    >
      <label class="text-sm">
        <span>开始时间 ISO</span>
        <input
          v-model="from"
          aria-label="开始时间 ISO"
          placeholder="默认前30天，例 2026-10-01T00:00:00Z"
          class="mt-1 w-full rounded-md border border-zinc-300 p-2 font-mono text-xs"
        />
      </label>
      <label class="text-sm">
        <span>结束时间 ISO</span>
        <input
          v-model="to"
          aria-label="结束时间 ISO"
          placeholder="默认当前时刻，带时区，右端不含"
          class="mt-1 w-full rounded-md border border-zinc-300 p-2 font-mono text-xs"
        />
      </label>
      <label class="text-sm">
        <span>物理会话 UUID（留空为全项目）</span>
        <input
          v-model="conversation"
          aria-label="会话 UUID"
          class="mt-1 w-full rounded-md border border-zinc-300 p-2 font-mono text-xs"
        />
      </label>
      <label class="text-sm">
        <span>分组方式</span>
        <select
          v-model="group"
          aria-label="分组方式"
          class="mt-1 w-full rounded-md border border-zinc-300 bg-white p-2 text-sm"
        >
          <option value="day">UTC 日</option>
          <option value="model">模型</option>
          <option value="purpose">用途</option>
          <option value="conversation">会话</option>
        </select>
      </label>
      <button type="submit" class="rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white">
        查询 / 刷新
      </button>
    </form>
    <p v-if="loading" role="status" class="text-sm text-zinc-500">正在加载用量…</p>
    <p
      v-if="error"
      role="alert"
      class="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800"
    >
      {{ error }}
    </p>
    <template v-if="report">
      <p class="break-all font-mono text-xs text-zinc-500">
        UTC {{ report.from }} → {{ report.to }}（右端不含）
      </p>
      <div class="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 class="text-lg font-semibold">调用 {{ report.totals.calls }}</h2>
        <p class="mt-1 text-sm text-zinc-600">
          成功 {{ report.totals.success_calls }} · 失败 {{ report.totals.error_calls }} · 中断
          {{ report.totals.aborted_calls }} · 耗时 {{ report.totals.duration_ms }} ms
        </p>
        <p v-if="report.totals.calls === 0" class="mt-3 text-sm text-zinc-500">
          该时间范围无模型调用记录
        </p>
        <dl class="mt-4 grid gap-3 sm:grid-cols-2">
          <div v-for="name in metrics" :key="name" class="min-w-0 rounded-md bg-zinc-50 p-3">
            <dt class="font-mono text-xs text-zinc-600">{{ name }}</dt>
            <dd class="mt-1 break-all font-mono text-lg">{{ report.totals[name].reported }}</dd>
            <dd class="text-xs text-zinc-500">
              已报告量 · 未报告 {{ report.totals[name].missing_calls }} 次
            </dd>
          </div>
        </dl>
        <p class="mt-4 text-sm font-medium">
          <span v-if="report.currency && report.totals.estimated_cost.known_amount !== null">
            已知部分估价 {{ report.currency }} {{ report.totals.estimated_cost.known_amount }}
          </span>
          <span v-else>费用未知</span>（非账单）
        </p>
        <p class="text-sm text-zinc-600">
          已估价 {{ report.totals.estimated_cost.priced_calls }} 次 · 未估价
          {{ report.totals.estimated_cost.unpriced_calls }} 次
        </p>
        <p class="mt-2 text-xs text-zinc-500">
          embedding 的输出 token
          可不适用；reasoning/缓存是明细，不能额外叠加计费。未估价部分不包含在已知金额中。
        </p>
        <p v-if="report.pricing_revision" class="mt-2 break-all font-mono text-xs text-zinc-500">
          价格配置 {{ report.pricing_revision }}
        </p>
      </div>
      <section class="space-y-3" aria-label="用量分组">
        <h2 class="font-semibold">分组详情</h2>
        <p v-if="report.groups_truncated" class="text-sm text-amber-800">
          分组已截断，总计仍覆盖完整选择范围。
        </p>
        <div
          v-for="g in report.groups"
          :key="JSON.stringify(g.key)"
          class="rounded-lg border border-zinc-200 bg-white p-4"
        >
          <p class="break-all font-mono text-xs">
            {{
              Object.entries(g.key)
                .map(([k, v]) => `${k}=${v ?? "无会话"}`)
                .join(" / ")
            }}
          </p>
          <p class="mt-1 text-sm">
            调用 {{ g.totals.calls }} · total 已报告 {{ g.totals.total_tokens.reported }} · 未报告
            {{ g.totals.total_tokens.missing_calls }} 次
          </p>
        </div>
      </section>
    </template>
  </section>
</template>
