import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolTokenUsage, type TokenUsage } from "@unfenced-ai/sdk";

export type UsageReporter = (usage: TokenUsage) => Promise<void>;

/** Keep registration schemas intact; observe only the final returned content. */
export function meteredTools(server: McpServer, report: UsageReporter): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);
      return (name: string, config: unknown, callback: (...args: unknown[]) => unknown) => {
        const wrapped = async (...args: unknown[]) => {
          const result = await callback(...args);
          // Reporting cannot turn a completed browser action into a retryable error.
          try {
            void report(toolTokenUsage(name, args[0], result)).catch(() => undefined);
          } catch {
            /* best effort */
          }
          return result;
        };
        return Reflect.apply(target.registerTool, target, [name, config, wrapped]);
      };
    },
  });
}
