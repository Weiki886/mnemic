import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App.vue";
import { router } from "../src/router.js";
import { PROJECT_STORAGE_KEY } from "../src/lib/project.js";

const projectId = "0192af7d-b792-7a41-90f8-9f0b2d6c6d8a";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("AppShell project gate", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: 500, code: null, detail: "offline" }), {
            status: 500,
          }),
      ),
    );
    await router.push("/memories");
    await router.isReady();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for a project UUID before loading project-scoped pages", async () => {
    const wrapper = mount(App, { global: { plugins: [router] } });

    expect(wrapper.text()).toContain("连接项目");
    expect(wrapper.text()).not.toContain("Belief ledger");

    await wrapper.find("input[aria-label='项目 UUID']").setValue("not-a-uuid");
    await wrapper.find("form").trigger("submit.prevent");

    expect(wrapper.text()).toContain("请输入合法的 UUID");
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBeNull();
  });

  it("connects a project and persists the selected UUID", async () => {
    const wrapper = mount(App, { global: { plugins: [router] } });

    await wrapper.find("input[aria-label='项目 UUID']").setValue(projectId);
    await wrapper.find("form").trigger("submit.prevent");
    await nextTick();
    await flushPromises();
    await flushPromises();

    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe(projectId);
    expect(wrapper.text()).toContain(projectId);
    expect(wrapper.text()).toContain("Belief ledger");
  });

  it("uses a previously selected project on reload", async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, projectId);
    const wrapper = mount(App, { global: { plugins: [router] } });
    await nextTick();
    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toContain(projectId);
    expect(wrapper.text()).not.toContain("连接项目");
  });
});
