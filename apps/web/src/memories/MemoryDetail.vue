<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import type { ApiClient, BeliefDetail, CorrectResult, ResolutionTrace } from "@mnemic/shared";
import {
  formatConfidence,
  formatDateTime,
  formatValue,
  relationLabel,
  statusLabel,
} from "../lib/format.js";

const props = defineProps<{
  projectId: string;
  beliefId: string;
  api: ApiClient;
}>();

const emit = defineEmits<{ corrected: [result: CorrectResult] }>();

const belief = ref<BeliefDetail | null>(null);
const traces = ref<ResolutionTrace[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const correction = ref("");
const saving = ref(false);
const actionError = ref<string | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const [detail, history] = await Promise.all([
      props.api.getBelief(props.projectId, props.beliefId),
      props.api.listResolutions(props.projectId, props.beliefId),
    ]);
    belief.value = detail;
    traces.value = history;
  } catch (err) {
    error.value = err instanceof Error ? err.message : "记忆读取失败";
  } finally {
    loading.value = false;
  }
}

async function submitCorrection() {
  const value = correction.value.trim();
  if (!value || saving.value || !belief.value || belief.value.status === "deleted") return;
  saving.value = true;
  actionError.value = null;
  try {
    const result = await props.api.correctBelief(props.projectId, props.beliefId, value);
    await load();
    emit("corrected", result);
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : "人工修正失败";
  } finally {
    saving.value = false;
  }
}

function confidenceMove(trace: ResolutionTrace): string {
  return `${formatConfidence(trace.confidenceBefore)} → ${formatConfidence(trace.confidenceAfter)}`;
}

onMounted(load);
</script>

<template>
  <section
    v-if="loading"
    class="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500"
  >
    正在读取记忆版本…
  </section>

  <section
    v-else-if="error"
    class="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-800"
  >
    <p class="font-medium">记忆读取失败</p>
    <p class="mt-1">{{ error }}</p>
    <RouterLink class="mt-4 inline-flex text-sm font-medium text-red-800 underline" to="/memories">
      返回记忆列表
    </RouterLink>
  </section>

  <article v-else-if="belief" class="space-y-6">
    <RouterLink class="text-sm font-medium text-zinc-500 hover:text-zinc-900" to="/memories">
      ← 记忆列表
    </RouterLink>

    <header class="rounded-2xl border border-zinc-200 bg-white p-6">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p class="font-mono text-[11px] uppercase tracking-[0.22em] text-record-600">
            Current belief
          </p>
          <h1 class="mt-1 text-2xl font-semibold tracking-tight text-zinc-950">
            {{ belief.subject }}
          </h1>
          <p class="mt-1 font-mono text-sm text-zinc-500">{{ belief.attribute }}</p>
        </div>
        <span
          class="rounded-full px-3 py-1 text-xs font-medium"
          :class="
            belief.status === 'active' ? 'bg-valid-50 text-valid-700' : 'bg-zinc-100 text-zinc-600'
          "
        >
          {{ statusLabel(belief.status) }}
        </span>
      </div>
      <div class="mt-6 rounded-xl bg-zinc-950 p-5 text-white">
        <p class="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-400">当前值</p>
        <p class="mt-2 break-words text-xl font-medium">{{ formatValue(belief.current_value) }}</p>
      </div>
      <dl class="mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <div>
          <dt class="text-zinc-500">置信度</dt>
          <dd class="mt-1 font-mono text-zinc-950">{{ formatConfidence(belief.confidence) }}</dd>
        </div>
        <div>
          <dt class="text-zinc-500">证据数</dt>
          <dd class="mt-1 font-mono text-zinc-950">{{ belief.evidence_count ?? 0 }}</dd>
        </div>
        <div>
          <dt class="text-zinc-500">重要性</dt>
          <dd class="mt-1 font-mono text-zinc-950">{{ formatConfidence(belief.importance) }}</dd>
        </div>
        <div>
          <dt class="text-zinc-500">记录时间</dt>
          <dd class="mt-1 font-mono text-xs text-zinc-950">
            {{ formatDateTime(belief.created_at) }}
          </dd>
        </div>
      </dl>
    </header>

    <section class="rounded-2xl border border-zinc-200 bg-white p-6">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold text-zinc-950">版本时间线</h2>
        <div class="flex gap-3 font-mono text-[11px]">
          <span class="flex items-center gap-1 text-valid-700">
            <span class="h-2 w-2 rounded-full bg-valid-500" />事实时间
          </span>
          <span class="flex items-center gap-1 text-record-700">
            <span class="h-2 w-2 rounded-full bg-record-500" />记录时间
          </span>
        </div>
      </div>
      <ol class="mt-6 space-y-4">
        <li
          v-for="version in belief.versions"
          :key="version.id"
          class="relative rounded-xl border border-zinc-200 p-4"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="text-lg font-medium text-zinc-950">{{ formatValue(version.value) }}</p>
              <p class="mt-1 font-mono text-xs text-zinc-500">
                confidence {{ formatConfidence(version.confidence) }}
              </p>
            </div>
            <RouterLink
              v-if="version.source"
              class="rounded-md border border-zinc-200 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              :to="`/conversations/${version.source.conversation_id}`"
            >
              查看来源会话
            </RouterLink>
          </div>
          <div class="mt-4 grid gap-3 sm:grid-cols-2">
            <div class="rounded-lg bg-valid-50 px-3 py-2">
              <p class="text-[11px] font-semibold uppercase tracking-wide text-valid-700">
                事实时间
              </p>
              <p class="mt-1 font-mono text-xs text-valid-900">
                {{ formatDateTime(version.valid_from) }} → {{ formatDateTime(version.valid_to) }}
              </p>
            </div>
            <div class="rounded-lg bg-record-50 px-3 py-2">
              <p class="text-[11px] font-semibold uppercase tracking-wide text-record-700">
                记录时间
              </p>
              <p class="mt-1 font-mono text-xs text-record-900">
                {{ formatDateTime(version.recorded_from) }} →
                {{ formatDateTime(version.recorded_to) }}
              </p>
            </div>
          </div>
        </li>
      </ol>
    </section>

    <section class="grid gap-6 lg:grid-cols-[1fr_0.8fr]">
      <div class="rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 class="text-lg font-semibold text-zinc-950">消解历史</h2>
        <p v-if="traces.length === 0" class="mt-3 text-sm text-zinc-500">
          这条记忆还没有额外的自动消解记录。
        </p>
        <ol v-else class="mt-4 space-y-3">
          <li v-for="trace in traces" :key="trace.id" class="rounded-lg border border-zinc-200 p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span
                class="rounded-full bg-record-50 px-2 py-0.5 text-xs font-medium text-record-700"
              >
                {{ relationLabel(trace.relation) }}
              </span>
              <span class="font-mono text-xs text-zinc-500">{{ confidenceMove(trace) }}</span>
            </div>
            <p class="mt-2 font-mono text-[11px] text-zinc-500">
              {{ formatDateTime(trace.createdAt) }}
            </p>
            <details class="mt-2 text-xs text-zinc-600">
              <summary class="cursor-pointer font-medium">决策上下文</summary>
              <pre class="mt-2 overflow-x-auto rounded bg-zinc-50 p-2 font-mono">{{
                JSON.stringify(trace.policies, null, 2)
              }}</pre>
            </details>
          </li>
        </ol>
      </div>

      <form
        v-if="belief.status !== 'deleted'"
        class="rounded-2xl border border-zinc-200 bg-white p-6"
        @submit.prevent="submitCorrection"
      >
        <p class="font-mono text-[11px] uppercase tracking-[0.22em] text-record-600">
          Human authority
        </p>
        <h2 class="mt-1 text-lg font-semibold text-zinc-950">人工修正</h2>
        <p class="mt-2 text-sm text-zinc-500">你的修正会成为高权威证据，旧值保留在版本时间线中。</p>
        <label class="sr-only" for="correction-value">人工修正后的新值</label>
        <input
          id="correction-value"
          v-model="correction"
          aria-label="人工修正后的新值"
          class="mt-4 h-10 w-full rounded-md border border-zinc-200 px-3 text-sm"
          placeholder="输入确认后的新值"
        />
        <p v-if="actionError" class="mt-3 text-sm text-red-700">{{ actionError }}</p>
        <button
          type="submit"
          :disabled="!correction.trim() || saving"
          class="mt-4 h-10 w-full rounded-md bg-zinc-950 px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
        >
          {{ saving ? "正在保存…" : "保存修正" }}
        </button>
      </form>
      <div v-else class="rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 class="text-lg font-semibold text-zinc-950">人工修正</h2>
        <p class="mt-2 text-sm text-zinc-500">这条记忆已删除。请先在记忆列表恢复，再进行修正。</p>
        <RouterLink class="mt-4 inline-flex text-sm font-medium underline" to="/memories">
          返回记忆列表
        </RouterLink>
      </div>
    </section>
  </article>
</template>
