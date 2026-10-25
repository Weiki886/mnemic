import { expect, it } from "vitest";
import { parseUsagePricing, usageWindow } from "../src/usage/pricing.js";
const rate = {
  provider_name: "offline",
  model_id: "chat",
  slot: "chat",
  effective_from: "2026-01-01T00:00:00Z",
  input_per_million: "1.25",
  output_per_million: "2",
  cached_input_per_million: "0.1",
};
it("defaults to no prices and accepts explicit zero prices without fetching a provider", () => {
  expect(parseUsagePricing(undefined)).toEqual({ currency: null, rates: [], revision: null });
  const p = parseUsagePricing(
    JSON.stringify({ currency: "CNY", rates: [{ ...rate, input_per_million: "0" }] }),
  );
  expect(p.currency).toBe("CNY");
  expect(p.rates[0]!.input_per_million).toBe("0");
  expect(p.revision).toMatch(/^[a-f0-9]{64}$/);
});
it("rejects duplicate effective rates, invalid decimals and unknown fields without echoing config", () => {
  for (const rates of [
    [rate, rate],
    [{ ...rate, input_per_million: "-1" }],
    [{ ...rate, output_per_million: "1e9" }],
    [{ ...rate, cached_input_per_million: "0.1234567" }],
    [{ ...rate, api_key: "PRIVATE" }],
    [{ ...rate, effective_from: "2026-01-01T00:00:00.000001Z" }],
    [{ ...rate, effective_from: "0000-01-01T00:00:00Z" }],
    [{ ...rate, effective_from: "0001-01-01T00:00:00+01:00" }],
  ])
    expect(() => parseUsagePricing(JSON.stringify({ currency: "USD", rates }))).toThrow(
      "MNEMIC_USAGE_PRICES_JSON invalid",
    );
  expect(() => parseUsagePricing("PRIVATE malformed")).toThrow("MNEMIC_USAGE_PRICES_JSON invalid");
});
it("normalizes timezones, defaults to 30 days and rejects unbounded or reversed windows", () => {
  const now = new Date("2026-10-25T00:00:00Z");
  expect(usageWindow({}, now)).toEqual({ from: "2026-09-25T00:00:00.000Z", to: now.toISOString() });
  expect(
    usageWindow({ from: "2026-10-01T08:00:00+08:00", to: "2026-10-02T08:00:00+08:00" }, now).from,
  ).toBe("2026-10-01T00:00:00.000Z");
  for (const q of [
    { to: "0001-01-01T00:00:00Z" },
    { from: "2020-01-01T00:00:00Z" },
    { from: now.toISOString(), to: now.toISOString() },
  ])
    expect(() => usageWindow(q, now)).toThrow("usage window");
});
