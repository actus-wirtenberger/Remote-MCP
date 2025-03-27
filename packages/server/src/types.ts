import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { MCPRouter } from './router.js';
import type { CallToolResult as MCPCallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type AppRouter = ReturnType<MCPRouter['createTRPCRouter']>;
export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;

// Support both object format and tuple format for CallToolResult
export type CallToolResult =
  | MCPCallToolResult
  | [any[], any]; // content_and_artifact format (tuple format)
