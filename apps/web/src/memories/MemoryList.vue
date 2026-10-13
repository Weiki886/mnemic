<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import type { ApiClient, BeliefListItem, BeliefListParams } from "@mnemic/shared";
import { formatConfidence, formatDateTime, formatValue, statusLabel } from "../lib/format.js";

const PAGE_SIZE = 50;
type StatusFilter = NonNullable<BeliefListParams["status"]>;

const props = defineProps<{
  projectId: string;
  api: ApiClient;
}>();

const rows = ref<BeliefListItem[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const actionError = ref<string | null>(null);
const status = ref<StatusFilter>("active");
const profileOnly = ref(false);
const query = ref("");
const offset = ref(0);
let requestSequence = 0;

async function load() {
  const request = ++requestSequence;
  loading.value = true;
  error.value = null;
  try {
    const params: BeliefListParams = {
      status: status.value,
      limit: PAGE_SIZE,
      offset: offset.value,
    };
    if (profileOnly.value) params.profile = "true";
    const q = query.value.trim();
    if (q) params.q = q;
    const result = await props.api.listBeliefs(props.projectId, params);
    if (request === requestSequence) rows.value = result;
  } catch (err) {
    if (request !== requestSequence) return;
    rows.value = [];
    error.value = err instanceof Error ? err.message : "未知错误";
  } finally {
    if (request === requestSequence) loading.value = false;
  }
}

function applyFilters() {
  offset.value = 0;
  void load();
}

function nextPage() {
  offset.value += PAGE_SIZE;
  void load();
}

function previousPage() {
  offset.value = Math.max(0, offset.value - PAGE_SIZE);
  void load();
}

async function remove(memory: BeliefListItem) {
  actionError.value = null;
  try {
    await props.api.deleteBelief(props.projectId, memory.id);
    await load();
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : "删除失败";
  }
}

async function restore(memory: BeliefListItem) {
  actionError.value = null;
  try {
    await props.api.restoreBelief(props.projectId, memory.id);
    await load();
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : "恢复失败";
  }
}

onMounted(load);
</script>

<template>
  <section class="space-y-5">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="font-mono text-[11px] uppercase tracking-[0.22em] text-record-600">
          Belief ledger
        </p>
        <h1 class="mt-1 text-2xl font-semibold tracking-tight text-zinc-950">记忆</h1>
      </div>
      <form class="flex flex-wrap items-center gap-2" @submit.prevent="applyFilters">
        <label class="sr-only" for="memory-status">状态</label>
        <select
          id="memory-status"
          v-model="status"
          aria-label="状态"
          class="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm"
        >
          <option value="active">生效中</option>
          <option value="deleted">已删除</option>
          <option value="retracted">已撤回</option>
          <option value="all">全部</option>
        </select>
        <label
          class="flex h-9 items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-700"
        >
          <input v-model="profileOnly" aria-label="只看项目画像" type="checkbox" class="rounded" />
          项目画像
        </label>
        <label class="sr-only" for="memory-search">搜索主体或属性</label>
        <input
          id="memory-search"
          v-model="query"
          aria-label="搜索主体或属性"
          type="search"
          placeholder="搜索主体或属性"
          class="h-9 w-56 rounded-md border border-zinc-200 bg-white px-3 text-sm"
        />
        <button
          type="submit"
          class="h-9 rounded-md bg-zinc-950 px-4 text-sm font-medium text-white hover:bg-zinc-800 focus:outline-zinc-900"
        >
          搜索
        </button>
      </form>
    </div>

    <p
      v-if="actionError"
      class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
    >
      {{ actionError }}
    </p>

    <div
      v-if="loading"
      class="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500"
    >
      正在读取记忆…
    </div>
    <div
      v-else-if="error"
      class="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-800"
    >
      <p class="font-medium">记忆加载失败</p>
      <p class="mt-1">{{ error }}</p>
    </div>
    <div
      v-else-if="rows.length === 0"
      class="rounded-xl border border-dashed border-zinc-300 bg-white p-8 text-center"
    >
      <p class="text-sm font-medium text-zinc-800">暂无记忆</p>
      <p class="mt-1 text-sm text-zinc-500">换一个筛选条件，或先在对话中产生新的事实。</p>
    </div>
    <div v-else class="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <table class="w-full text-left text-sm">
        <thead
          class="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500"
        >
          <tr>
            <th class="px-4 py-3 font-medium">主体 / 属性</th>
            <th class="px-4 py-3 font-medium">当前值</th>
            <th class="px-4 py-3 font-medium">状态</th>
            <th class="px-4 py-3 font-medium">置信度</th>
            <th class="px-4 py-3 font-medium">证据</th>
            <th class="px-4 py-3 font-medium">记录时间</th>
            <th class="px-4 py-3" />
          </tr>
        </thead>
        <tbody class="divide-y divide-zinc-100">
          <tr v-for="memory in rows" :key="memory.id" class="align-top hover:bg-zinc-50/70">
            <td class="px-4 py-3">
              <RouterLink
                class="font-medium text-zinc-950 hover:text-record-700"
                :to="`/memories/${memory.id}`"
              >
                {{ memory.subject }}
              </RouterLink>
              <div class="mt-0.5 font-mono text-xs text-zinc-500">{{ memory.attribute }}</div>
              <span
                v-if="memory.is_profile"
                class="mt-2 inline-flex rounded bg-record-50 px-1.5 py-0.5 text-[11px] text-record-700"
              >
                项目画像
              </span>
            </td>
            <td class="max-w-xs px-4 py-3 text-zinc-800">
              {{ formatValue(memory.current_value) }}
            </td>
            <td class="px-4 py-3">
              <span
                class="inline-flex rounded-full px-2 py-0.5 text-xs"
                :class="
                  memory.status === 'active'
                    ? 'bg-valid-50 text-valid-700'
                    : 'bg-zinc-100 text-zinc-600'
                "
              >
                {{ statusLabel(memory.status) }}
              </span>
            </td>
            <td class="px-4 py-3 font-mono text-xs text-zinc-600">
              {{ formatConfidence(memory.confidence) }}
            </td>
            <td class="px-4 py-3 font-mono text-xs text-zinc-600">
              {{ memory.evidence_count ?? 0 }}
            </td>
            <td class="px-4 py-3 font-mono text-xs text-zinc-500">
              {{ formatDateTime(memory.created_at) }}
            </td>
            <td class="px-4 py-3 text-right">
              <button
                v-if="memory.status === 'active'"
                type="button"
                class="text-xs font-medium text-red-700 hover:text-red-900"
                :aria-label="`删除记忆 ${memory.subject} / ${memory.attribute}`"
                @click="remove(memory)"
              >
                删除
              </button>
              <button
                v-else-if="memory.status === 'deleted'"
                type="button"
                class="text-xs font-medium text-valid-700 hover:text-valid-800"
                :aria-label="`恢复记忆 ${memory.subject} / ${memory.attribute}`"
                @click="restore(memory)"
              >
                恢复
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="!loading && !error" class="flex items-center justify-between text-sm">
      <p class="font-mono text-xs text-zinc-500">offset {{ offset }}</p>
      <div class="flex gap-2">
        <button
          type="button"
          :disabled="offset === 0"
          class="rounded-md border border-zinc-200 px-3 py-1.5 font-medium disabled:opacity-40"
          aria-label="上一页"
          @click="previousPage"
        >
          上一页
        </button>
        <button
          type="button"
          :disabled="rows.length < PAGE_SIZE"
          class="rounded-md border border-zinc-200 px-3 py-1.5 font-medium disabled:opacity-40"
          aria-label="下一页"
          @click="nextPage"
        >
          下一页
        </button>
      </div>
    </div>
  </section>
</template>
