import { describe, expect, it } from "vitest";
import * as schemas from "../src/chat.js";

const session = {
  id: "01920000-0000-7000-8000-000000000001",
  title: "数据库选型",
  started_at: "2026-10-19T00:00:00.000Z",
  ended_at: null,
  message_count: 2,
};

describe("会话列表响应契约（#31）", () => {
  it("异常历史必须显式标记且不能伪造消息数", () => {
    const broken = { ...session, message_count: null, history_error: "unavailable" };
    expect(schemas.ConversationListItemSchema.parse(broken)).toEqual(broken);
    expect(
      schemas.ConversationListItemSchema.safeParse({ ...session, message_count: null }).success,
    ).toBe(false);
    expect(
      schemas.ConversationListItemSchema.safeParse({ ...session, history_error: "unavailable" })
        .success,
    ).toBe(false);
  });
  it("列表复用导出的单条 schema，单条格式不变", () => {
    expect(schemas.ConversationListItemSchema).toBeDefined();
    expect(schemas.ConversationListSchema.element).toBe(schemas.ConversationListItemSchema);
    expect(schemas.ConversationListItemSchema.parse(session)).toEqual(session);
  });

  it.each(
    [[], [session], [{ ...session, title: null, ended_at: session.started_at }]].map((rows) => ({
      rows,
    })),
  )("接受合法列表（case $#）", ({ rows }) => {
    expect(schemas.ConversationListSchema).toBeDefined();
    expect(schemas.ConversationListSchema.parse(rows)).toEqual(rows);
  });

  it.each(
    [
      {},
      [null],
      [{ ...session, id: "bad" }],
      [{ ...session, started_at: "bad" }],
      [{ ...session, ended_at: "bad" }],
      [{ ...session, message_count: -1 }],
      [{ ...session, message_count: 1.5 }],
      [{ ...session, message_count: "2" }],
      [{ ...session, title: 42 }],
      Array.from({ length: 1001 }, () => session),
    ].map((rows) => ({ rows })),
  )("拒绝不兼容响应（case $#）", ({ rows }) => {
    expect(schemas.ConversationListSchema).toBeDefined();
    expect(schemas.ConversationListSchema.safeParse(rows).success).toBe(false);
  });
});
