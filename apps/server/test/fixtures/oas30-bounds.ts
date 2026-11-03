/** Ajv uses JSON Schema numeric exclusive bounds; OAS3.0 uses minimum + boolean.
 * Convert only schema positions on a copy, leaving artifact and example data untouched. */
export function jsonSchemaBounds(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    throw Error("expected schema object");
  const copy = structuredClone(schema) as Record<string, unknown>;
  function visit(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    for (const [bound, exclusive] of [
      ["minimum", "exclusiveMinimum"],
      ["maximum", "exclusiveMaximum"],
    ] as const) {
      if (typeof node[exclusive] !== "boolean") continue;
      if (node[exclusive]) {
        if (typeof node[bound] !== "number") throw Error("exclusive bound requires numeric limit");
        node[exclusive] = node[bound];
        delete node[bound];
      } else delete node[exclusive];
    }
    if (node.properties && typeof node.properties === "object")
      for (const child of Object.values(node.properties)) visit(child);
    for (const key of ["items", "additionalProperties", "not"]) visit(node[key]);
    for (const key of ["allOf", "anyOf", "oneOf"])
      if (Array.isArray(node[key])) for (const child of node[key]) visit(child);
  }
  visit(copy);
  return copy;
}
