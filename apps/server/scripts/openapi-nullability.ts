/** Zod-to-openapi v7 emits {nullable:true} for unconstrained unknown JSON and
 * omits null from nullable enums. OAS 3.0 requires type with nullable, and enum
 * remains a separate constraint. Preserve source semantics without relaxing
 * required properties or changing the runtime schemas.
 * https://spec.openapis.org/oas/v3.0.3.html#schema-object
 */
export function normalizeNullability(schema: unknown): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const node = schema as Record<string, unknown>;
  if (node.nullable === true) {
    if (node.type === undefined)
      delete node.nullable; // {} already includes JSON null
    else if (Array.isArray(node.enum) && !node.enum.includes(null))
      node.enum = [...node.enum, null];
  }
  // Schema positions only: never interpret examples or arbitrary JSON values as schemas.
  if (node.properties && typeof node.properties === "object")
    for (const child of Object.values(node.properties)) normalizeNullability(child);
  for (const key of ["items", "additionalProperties", "not"]) normalizeNullability(node[key]);
  for (const key of ["allOf", "anyOf", "oneOf"])
    if (Array.isArray(node[key])) for (const child of node[key]) normalizeNullability(child);
}
