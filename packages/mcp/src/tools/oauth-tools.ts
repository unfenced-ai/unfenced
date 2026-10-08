import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** Advertise the mounted cloud endpoint's per-tool OAuth requirement. */
export function oauthTools(server: McpServer): McpServer {
  const securitySchemes = [{ type: "oauth2", scopes: ["mcp"] }];
  // SDK 1.x drops securitySchemes from registerTool() while constructing tools/list.
  // Decorate that response at the low-level handler so the field reaches the wire.
  const lowLevel = server.server;
  if (lowLevel?.setRequestHandler) {
    type Handler = (request: unknown, extra: unknown) => unknown;
    const setRequestHandler = lowLevel.setRequestHandler.bind(lowLevel) as (
      schema: unknown,
      handler: Handler,
    ) => void;
    lowLevel.setRequestHandler = ((schema: unknown, handler: Handler) => {
      if (schema !== ListToolsRequestSchema) return setRequestHandler(schema, handler);
      return setRequestHandler(schema, async (request, extra) => {
        const result = await handler(request, extra);
        if (!result || typeof result !== "object" || !("tools" in result)) return result;
        if (!Array.isArray(result.tools)) return result;
        const tools = result.tools as Array<Record<string, unknown>>;
        return {
          ...result,
          tools: tools.map((tool) => ({ ...tool, securitySchemes })),
        };
      });
    }) as typeof lowLevel.setRequestHandler;
  }
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);
      return (name: string, config: Record<string, unknown>, callback: unknown) => {
        const previousMeta =
          config["_meta"] && typeof config["_meta"] === "object"
            ? (config["_meta"] as Record<string, unknown>)
            : {};
        return Reflect.apply(target.registerTool, target, [
          name,
          {
            ...config,
            securitySchemes,
            _meta: { ...previousMeta, securitySchemes },
          },
          callback,
        ]);
      };
    },
  });
}
