/** Scale authored absolute type sizes once; inherited/em/rem sizes follow the root.
 * This applies equally to lazy-loaded lab styles, without zooming the WebGL canvas. */
export function scaleFontValue(property: string, value: string): string {
  if (value.includes("--ui-text-scale")) return value;
  if (property === "font-size" && /(?:\d|\.)(?:px|vw|vh)\b/.test(value)) {
    return `calc((${value}) * var(--ui-text-scale, 1))`;
  }
  if (property === "font") {
    return value.replace(/(?<![\w.-])(\d*\.?\d+)(px|vw|vh)\b/, size => `calc(${size} * var(--ui-text-scale, 1))`);
  }
  return value;
}

export function interfaceTypography() {
  return {
    postcssPlugin: "viscera-interface-typography",
    Declaration(declaration: { prop: string; value: string }) {
      if (declaration.prop === "font-size" || declaration.prop === "font") {
        declaration.value = scaleFontValue(declaration.prop, declaration.value);
      }
    },
  };
}
