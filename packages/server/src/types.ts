import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { MCPRouter } from './router.js';

export type AppRouter = ReturnType<MCPRouter['createTRPCRouter']>;
export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;

// Define the content types
export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  data: string; // base64
  mimeType: string;
}

export interface ResourceContent {
  type: 'resource';
  resource: {
    text: string;
    uri: string;
    mimeType?: string;
  };
}

export type ContentItem = TextContent | ImageContent | ResourceContent;

// Support both object format and tuple format for CallToolResult
export type CallToolResult =
  | { content: ContentItem[]; isError?: boolean; artifact?: any }
  | [ContentItem[], any]; // content_and_artifact format (tuple format)
