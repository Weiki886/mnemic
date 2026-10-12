<script setup lang="ts">
import { RouterLink, RouterView } from "vue-router";

const links = [
  { to: "/memories", label: "记忆" },
  { to: "/conversations", label: "对话" },
];
</script>

<template>
  <div class="min-h-screen bg-zinc-50 font-sans text-zinc-900">
    <header class="border-b border-zinc-200 bg-white">
      <div class="mx-auto flex h-14 max-w-6xl items-center gap-8 px-6">
        <span class="font-mono text-sm font-semibold tracking-tight">mnemic</span>
        <nav class="flex gap-1 text-sm">
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
      </div>
    </header>
    <main class="mx-auto max-w-6xl px-6 py-8">
      <RouterView />
    </main>
  </div>
</template>
