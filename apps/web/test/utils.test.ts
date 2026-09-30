import { describe, expect, it } from "vitest";
import { cn } from "../src/lib/utils.js";

describe("cn（shadcn-vue 基础工具）", () => {
  it("合并类名并解决 tailwind 冲突", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    const showHidden = false;
    expect(cn("text-zinc-500", showHidden && "hidden", "font-mono")).toBe(
      "text-zinc-500 font-mono",
    );
  });
});
