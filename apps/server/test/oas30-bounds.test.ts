import { expect, it } from "vitest";
import { Ajv } from "ajv";
import { jsonSchemaBounds } from "./fixtures/oas30-bounds.js";
it("OAS3 boolean exclusive bounds preserve strict comparisons in independent Ajv validation", () => {
  const original = {
    type: "number",
    minimum: 0,
    exclusiveMinimum: true,
    maximum: 5,
    exclusiveMaximum: true,
  };
  const validate = new Ajv().compile(jsonSchemaBounds(original));
  expect(validate(0)).toBe(false);
  expect(validate(5)).toBe(false);
  expect(validate(1)).toBe(true);
  expect(original).toEqual({
    type: "number",
    minimum: 0,
    exclusiveMinimum: true,
    maximum: 5,
    exclusiveMaximum: true,
  });
});
it("inclusive bounds, nested schemas and arbitrary example data are not weakened or rewritten", () => {
  const example = { minimum: 7, exclusiveMinimum: true };
  const adapted = jsonSchemaBounds({
    type: "object",
    properties: { n: { type: "number", minimum: 0, exclusiveMinimum: false } },
    example,
  });
  const validate = new Ajv({ strict: false }).compile(adapted);
  expect(validate({ n: 0 })).toBe(true);
  expect(validate({ n: -1 })).toBe(false);
  expect(adapted.example).toEqual(example);
});
