import { createRouter, createWebHistory } from "vue-router";
import MemoriesView from "./views/MemoriesView.vue";
import ConversationsView from "./views/ConversationsView.vue";

/** 路由（#8 拆分 2/3 骨架）：页面本体与详情路由归 3/3 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/memories" },
    { path: "/memories", name: "memories", component: MemoriesView },
    { path: "/conversations", name: "conversations", component: ConversationsView },
  ],
});
