import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { MCPRouter } from './router.js';
import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';

export type AppRouter = ReturnType<MCPRouter['createTRPCRouter']>;
export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;

// Support both object format and tuple format for CallToolResult
export type CallToolResult =
  | { content: ContentBlock[], isError?: boolean, artifact?: any }
  | [ContentBlock[], any]; // content_and_artifact format (tuple format)
