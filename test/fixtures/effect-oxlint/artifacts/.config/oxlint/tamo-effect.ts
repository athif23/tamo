import { defineRule, eslintCompatPlugin, type ESTree } from "@oxlint/plugins";

// Keep this rule self-contained so the
// consuming project needs only @oxlint/plugins, never Tamo at lint time.
const rule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep Layers outside Context.Service classes." },
    messages: { layer: "Context.Service classes define identity and contract only. Export this Layer as a top-level module value." },
  },
  create(context) {
    const imports = new Map<string, string>();
    const asRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === "object" && value !== null;
    const referencesLayer = (node: unknown): boolean => {
      if (Array.isArray(node)) return node.some(referencesLayer);
      if (!asRecord(node)) return false;
      if (node.type === "Identifier" && typeof node.name === "string" && imports.get(node.name) === "Layer") return true;
      return Object.entries(node).some(([key, value]) => key !== "parent" && key !== "loc" && key !== "range" && referencesLayer(value));
    };
    const memberName = (member: ESTree.ClassBody["body"][number]): string | undefined => {
      if (!("key" in member)) return undefined;
      const key = member.key;
      if (key && "name" in key && typeof key.name === "string") return key.name;
      return key && "value" in key && typeof key.value === "string" ? key.value : undefined;
    };
    const extendsContextService = (node: ESTree.Class): boolean => {
      let base = node.superClass;
      while (base?.type === "CallExpression") base = base.callee;
      if (base?.type !== "MemberExpression" || base.computed) return false;
      if (base.property.type !== "Identifier" || base.property.name !== "Service") return false;
      return base.object.type === "Identifier" && imports.get(base.object.name) === "Context";
    };
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "effect") return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier") {
            const imported = specifier.imported;
            imports.set(specifier.local.name, "name" in imported ? imported.name : String(imported.value));
          }
        }
      },
      ClassDeclaration(node) {
        if (!extendsContextService(node)) return;
        for (const member of node.body.body) {
          if (!("static" in member) || !member.static) continue;
          const name = memberName(member);
          if (/^(defaultLayer|layer|live|default)$/iu.test(name ?? "") || ("value" in member && referencesLayer(member.value))) context.report({ node: member, messageId: "layer" });
        }
      },
    };
  },
});

export default eslintCompatPlugin({ meta: { name: "tamo-effect" }, rules: { "no-layer-in-service-class": rule } });
