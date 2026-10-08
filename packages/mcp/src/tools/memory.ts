/**
 * The durable-memory tools - the agent's own scratchpad of task state that
 * survives across sessions. Never a place for secrets.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Unfenced } from "@unfenced-ai/sdk";
import { asToolResult, toolError, LOCAL_READ } from "./shared.js";

export function registerRemember(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "remember",
    {
      title: "Remember a note for later",
      description:
        "Jot a durable note under a short label, scoped to you, that survives across sessions - " +
        'your own scratchpad for the state of a task: "invoice #4471 downloaded, waiting on ' +
        'approval". Setting the same label again overwrites it. This is for what you are DOING, ' +
        "not for secrets: do NOT store passwords, API keys, OTPs or any credential here - it is " +
        "not a vault, and a credential written here is exposed. The scratchpad is small and " +
        "capped; forget notes you no longer need.",
      inputSchema: {
        key: z.string().describe('A short label to find this note by later, e.g. "invoice-4471"'),
        value: z
          .string()
          .describe("The note to keep - task state, not a secret. Never a password, token, or OTP"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ key, value }) => {
      try {
        const entry = await cloud.remember(key, value);
        return asToolResult({ remembered: entry.key, updatedAt: entry.updatedAt });
      } catch (error) {
        return asToolResult(toolError("remember-failed", error), true);
      }
    },
  );
}

export function registerRecall(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "recall",
    {
      title: "Recall what you noted",
      description:
        "Read back a durable note you stored with remember. Give a key to read that one note; " +
        "omit the key to list notes, newest first. Use prefix for a task namespace and limit to " +
        "keep the response small. Notes survive across sessions, so this is how a later session " +
        "picks up where an earlier one left off.",
      inputSchema: {
        key: z
          .string()
          .optional()
          .describe("The label the note was stored under. Omit to list notes"),
        prefix: z
          .string()
          .optional()
          .describe('When listing, return only keys beginning with this prefix, e.g. "invoice-"'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(64)
          .optional()
          .describe("When listing, return at most this many newest notes (maximum 64)"),
      },
      annotations: LOCAL_READ,
    },
    async ({ key, prefix, limit }) => {
      try {
        if (key === undefined) {
          const memories =
            prefix === undefined && limit === undefined
              ? await cloud.recall()
              : await cloud.recall({ prefix, limit });
          return asToolResult({ memories });
        }
        const memory = await cloud.recall(key);
        if (!memory) {
          return asToolResult(
            {
              error: "no-memory",
              detail: `nothing is stored under "${key}"`,
              remedy: "call recall with no key to list what you have stored",
            },
            true,
          );
        }
        return asToolResult({ memory });
      } catch (error) {
        return asToolResult(toolError("recall-failed", error), true);
      }
    },
  );
}

export function registerForget(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "forget",
    {
      title: "Forget a note",
      description:
        "Delete a durable note by its label. Returns whether a note was actually removed - false " +
        "means nothing was stored under that label. Use it to keep your scratchpad to what still " +
        "matters, and to make room when it is full.",
      inputSchema: {
        key: z.string().describe("The label of the note to delete"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ key }) => {
      try {
        const removed = await cloud.forget(key);
        return asToolResult({ forgotten: key, removed });
      } catch (error) {
        return asToolResult(toolError("forget-failed", error), true);
      }
    },
  );
}
