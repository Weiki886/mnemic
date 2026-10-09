import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import App from "../src/App.vue";
import { router } from "../src/router.js";

/** AppShell（#8 拆分 2/3）：导航 + 路由出口；页面本体归 3/3。 */
describe("AppShell", () => {
  it("渲染记忆/对话导航与路由出口", async () => {
    router.push("/memories");
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    const nav = wrapper.find("nav");
    expect(nav.exists()).toBe(true);
    expect(nav.text()).toContain("记忆");
    expect(nav.text()).toContain("对话");
    expect(wrapper.text()).toContain("记忆列表");
  });

  it("对话路由渲染占位页", async () => {
    router.push("/conversations");
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    expect(wrapper.text()).toContain("对话");
  });
});
