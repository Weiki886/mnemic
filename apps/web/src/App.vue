<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink, RouterView } from "vue-router";
import { api } from "./api.js";
import { isProjectId, PROJECT_STORAGE_KEY } from "./lib/project.js";

const links = [
  { to: "/memories", label: "记忆" },
  { to: "/conversations", label: "对话" },
];

const stored =
  (globalThis.localStorage?.getItem(PROJECT_STORAGE_KEY) ?? "") ||
  import.meta.env.VITE_PROJECT_ID ||
  "";
const projectId = ref(isProjectId(stored) ? stored : "");
const projectInput = ref(projectId.value);
const projectError = ref("");
const connected = computed(() => isProjectId(projectId.value));

function connectProject() {
  const id = projectInput.value.trim();
  if (!isProjectId(id)) {
    projectError.value = "请输入合法的 UUID";
    return;
  }
  projectError.value = "";
  projectId.value = id;
  globalThis.localStorage?.setItem(PROJECT_STORAGE_KEY, id);
}

function changeProject() {
  globalThis.localStorage?.removeItem(PROJECT_STORAGE_KEY);
  projectId.value = "";
  projectInput.value = "";
}
</script>

<template>
  <div class="min-h-screen bg-zinc-50 font-sans text-zinc-900">
    <header class="border-b border-zinc-200 bg-white">
      <div class="mx-auto flex h-14 max-w-6xl flex-wrap items-center gap-6 px-6">
        <span class="font-mono text-sm font-semibold tracking-tight">mnemic</span>
        <nav v-if="connected" class="flex gap-1 text-sm">
          <RouterLink
            v-for="link in links"
            :key="link.to"
            :to="link.to"
            class="rounded-md px-3 py-1.5 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
            active-class="bg-zinc-100 font-medium text-zinc-900"
          >
            {{ link.label }}
          </RouterLink>
        </nav>
        <div v-if="connected" class="ml-auto flex items-center gap-3">
          <span class="max-w-56 truncate font-mono text-[11px] text-zinc-500">{{ projectId }}</span>
          <button
            type="button"
            class="text-xs font-medium text-zinc-500 hover:text-zinc-900"
            aria-label="更换项目"
            @click="changeProject"
          >
            更换
          </button>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-6xl px-6 py-8">
      <section
        v-if="!connected"
        class="mx-auto max-w-xl rounded-2xl border border-zinc-200 bg-white p-8"
      >
        <p class="font-mono text-[11px] uppercase tracking-[0.22em] text-record-600">
          Project scope
        </p>
        <h1 class="mt-2 text-2xl font-semibold tracking-tight">连接项目</h1>
        <p class="mt-2 text-sm leading-6 text-zinc-500">
          输入当前演示项目的 UUID。所有记忆和对话都按项目隔离，页面不会跨项目读取数据。
        </p>
        <form class="mt-6 flex gap-2" @submit.prevent="connectProject">
          <label class="sr-only" for="project-id">项目 UUID</label>
          <input
            id="project-id"
            v-model="projectInput"
            aria-label="项目 UUID"
            class="h-10 min-w-0 flex-1 rounded-md border border-zinc-200 px-3 font-mono text-sm"
            placeholder="00000000-0000-7000-0000-000000000000"
          />
          <button
            type="submit"
            class="h-10 shrink-0 rounded-md bg-zinc-950 px-4 text-sm font-medium text-white hover:bg-zinc-800"
          >
            连接
          </button>
        </form>
        <p v-if="projectError" class="mt-3 text-sm text-red-700">{{ projectError }}</p>
      </section>

      <RouterView v-else v-slot="{ Component }">
        <component :is="Component" :project-id="projectId" :api="api" />
      </RouterView>
    </main>
  </div>
</template>
