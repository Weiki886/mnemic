<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import type { ApiClient, ConversationListItem } from "@mnemic/shared";
import { formatDateTime } from "../lib/format.js";

const PAGE_SIZE = 50;

const props = defineProps<{
  projectId: string;
  api: ApiClient;
}>();

const rows = ref<ConversationListItem[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const offset = ref(0);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    rows.value = await props.api.listConversations(props.projectId, {
      limit: PAGE_SIZE,
      offset: offset.value,
    });
  } catch (err) {
    rows.value = [];
    error.value = err instanceof Error ? err.message : "对话加载失败";
  } finally {
    loading.value = false;
  }
}

function nextPage() {
  if (loading.value) return;
  offset.value += PAGE_SIZE;
  void load();
}

function previousPage() {
  if (loading.value) return;
  offset.value = Math.max(0, offset.value - PAGE_SIZE);
  void load();
}

onMounted(load);
</script>

<template>
  <section class="space-y-5">
    <div>
      <p class="font-mono text-[11px] uppercase tracking-[0.22em] text-valid-700">
        Conversation archive
      </p>
      <h1 class="mt-1 text-2xl font-semibold tracking-tight text-zinc-950">对话</h1>
      <p class="mt-2 text-sm text-zinc-500">只读查看回答引用了哪些记忆；交互式对话由 CLI 承担。</p>
    </div>

    <div
      v-if="loading"
      class="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500"
    >
      正在读取对话…
    </div>
    <div
      v-else-if="error"
      class="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-800"
    >
      对话加载失败：{{ error }}
    </div>
    <div
      v-else-if="rows.length === 0"
      class="rounded-xl border border-dashed border-zinc-300 bg-white p-8 text-center"
    >
      <p class="text-sm font-medium text-zinc-800">暂无对话</p>
      <p class="mt-1 text-sm text-zinc-500">通过 CLI 产生对话后，这里会显示回答的溯源链。</p>
    </div>
    <ul v-else class="space-y-3">
      <li v-for="conversation in rows" :key="conversation.id">
        <RouterLink
          class="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-zinc-200 bg-white p-5 hover:border-record-300 hover:shadow-sm"
          :to="`/conversations/${conversation.id}`"
        >
          <div>
            <h2 class="font-medium text-zinc-950">{{ conversation.title ?? "未命名对话" }}</h2>
            <p class="mt-1 font-mono text-xs text-zinc-500">
              {{ formatDateTime(conversation.started_at) }}
              <template v-if="conversation.ended_at">
                → {{ formatDateTime(conversation.ended_at) }}
              </template>
            </p>
          </div>
          <span class="rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-600">
            {{ conversation.message_count }} 条消息
          </span>
        </RouterLink>
      </li>
    </ul>

    <div v-if="!loading" class="flex items-center justify-between text-sm">
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
          :disabled="!!error || rows.length < PAGE_SIZE"
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
