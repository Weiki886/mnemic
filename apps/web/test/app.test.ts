import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App.vue";
import { router } from "../src/router.js";
import { PROJECT_STORAGE_KEY } from "../src/lib/project.js";

const projectId = "0192af7d-b792-7a41-90f8-9f0b2d6c6d8a";
const token = "web-session-only-" + "a".repeat(40);

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
    expect(wrapper.find("input[aria-label='服务端 Token']").exists()).toBe(true);
    await wrapper.find("input[aria-label='服务端 Token']").setValue(token);
    await wrapper.find("form").trigger("submit.prevent");
    await nextTick();
    await flushPromises();
    await flushPromises();

    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe(projectId);
    expect(wrapper.text()).toContain(projectId);
    expect(wrapper.text()).toContain("Belief ledger");
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(new Headers(calls[0]![1]?.headers).get("authorization")).toBe("Bearer " + token);
    expect(JSON.stringify(localStorage)).not.toContain(token);
    expect(localStorage.length).toBe(1);
    expect(wrapper.html()).not.toContain(token);
  });

  it("prefills a previously selected project but requires Token again on reload", async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, projectId);
    const wrapper = mount(App, { global: { plugins: [router] } });
    await nextTick();
    await flushPromises();
    await flushPromises();

    expect((wrapper.find("input[aria-label='项目 UUID']").element as HTMLInputElement).value).toBe(
      projectId,
    );
    expect(wrapper.text()).toContain("连接项目");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("empty Token blocks network; field is password and is not auto-completed", async () => {
    const wrapper = mount(App, { global: { plugins: [router] } });
    await wrapper.find("input[aria-label='项目 UUID']").setValue(projectId);
    await wrapper.find("form").trigger("submit.prevent");
    expect(wrapper.text()).toContain("请输入服务端 Token");
    expect(fetch).not.toHaveBeenCalled();
    const input = wrapper.find("input[aria-label='服务端 Token']");
    expect(input.attributes("type")).toBe("password");
    expect(input.attributes("autocomplete")).toBe("off");
    // 表单已改为纵向；横排遗留 flex-1 会把项目框压缩到小于 h-10。
    expect(wrapper.find("input[aria-label='项目 UUID']").classes()).not.toContain("flex-1");
  });

  it("changing project forgets the Token and unmounts protected views", async () => {
    const wrapper = mount(App, { global: { plugins: [router] } });
    await wrapper.find("input[aria-label='项目 UUID']").setValue(projectId);
    expect(wrapper.find("input[aria-label='服务端 Token']").exists()).toBe(true);
    await wrapper.find("input[aria-label='服务端 Token']").setValue(token);
    await wrapper.find("form").trigger("submit.prevent");
    await flushPromises();
    await wrapper.find("button[aria-label='更换项目']").trigger("click");
    expect(wrapper.text()).toContain("连接项目");
    expect(
      (wrapper.find("input[aria-label='服务端 Token']").element as HTMLInputElement).value,
    ).toBe("");
    expect(wrapper.text()).not.toContain("Belief ledger");
    const calls = vi.mocked(fetch).mock.calls.length;
    await wrapper.find("input[aria-label='项目 UUID']").setValue(projectId);
    await wrapper.find("form").trigger("submit.prevent");
    await flushPromises();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBeNull();
  });
});
