import { EventEmitter, on } from 'node:events';
import { ConsoleLogger, LogLevel, type Logger } from './logger.js';

import {
  type BlobResourceContents,
  CallToolRequestSchema,
  CallToolResultSchema,
  GetPromptRequestSchema,
  GetPromptResultSchema,
  type Implementation,
  type InitializeRequest,
  InitializeRequestSchema,
  type InitializeResult,
  InitializeResultSchema,
  LATEST_PROTOCOL_VERSION,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  type Prompt,
  type PromptMessage,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
  type Resource,
  type ServerCapabilities,
  type ServerNotification,
  SubscribeRequestSchema,
  type Tool,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { initTRPC } from '@trpc/server';
import { ZodError, type z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { CallToolResult } from './types.js';

export type ToolHandler<T> = (args: T) => Promise<CallToolResult>;
export type ResourceHandler = () => Promise<Resource[]>;
export type ResourceContentHandler = () => Promise<BlobResourceContents[]>;
export type PromptHandler = (
  args: Record<string, string>,
) => Promise<PromptMessage[]>;

export interface ToolDefinition<T> {
  description: string;
  schema: z.ZodType<T>;
  middlewares?: Middleware[];
}

export interface ResourceDefinition {
  name: string;
  description?: string;
  mimeType?: string;
  subscribe?: boolean;
  listHandler: ResourceHandler;
  readHandler: ResourceContentHandler;
  middlewares?: Middleware[];
}

export interface PromptDefinition {
  description?: string;
  arguments?: {
    name: string;
    description?: string;
    required?: boolean;
  }[];
  middlewares?: Middleware[];
}

export interface MCPRouterOptions {
  name: string;
  version: string;
  capabilities?: Partial<ServerCapabilities>;
  logger?: Logger;
  logLevel?: LogLevel;
}

export type Middleware = (
  request: unknown,
  next: (modifiedRequest: unknown) => Promise<unknown>,
) => Promise<unknown>;

interface Events {
  notification: (notification: ServerNotification) => void;

  resourceListChanged: () => void;
  resourceUpdated: (uri: string) => void;
  toolListChanged: () => void;
  promptListChanged: () => void;
  rootsListChanged: () => void;
}

export class MCPRouter {
  private logger: Logger;

  private tools = new Map<
    string,
    {
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      definition: ToolDefinition<any>;
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      handler: ToolHandler<any>;
    }
  >();

  private resources = new Map<string, ResourceDefinition>();

  private prompts = new Map<
    string,
    {
      definition: PromptDefinition;
      handler: PromptHandler;
    }
  >();

  private subscriptions = new Map<string, Set<string>>();
  private implementation: Implementation;
  private capabilities: ServerCapabilities;
  private events = new EventEmitter();

  constructor(options: MCPRouterOptions) {
    this.logger =
      options.logger ||
      new ConsoleLogger({
        level: options.logLevel || LogLevel.INFO,
        prefix: options.name,
      });

    this.implementation = {
      name: options.name,
      version: options.version,
    };

    this.capabilities = {
      tools: options.capabilities?.tools ?? {
        listChanged: false,
      },
      resources: options.capabilities?.resources ?? {
        subscribe: false,
        listChanged: false,
      },
      prompts: options.capabilities?.prompts ?? {
        listChanged: false,
      },
      logging: options.capabilities?.logging,
      experimental: options.capabilities?.experimental,
    };

    this.logger.debug('MCPRouter initialized', {
      name: options.name,
      version: options.version,
      capabilities: this.capabilities,
    });
  }

  private emit<T extends keyof Events>(
    event: T,
    ...args: Parameters<Events[T]>
  ): void {
    this.events.emit(event, ...args);
  }

  private _emitNotification(notification: ServerNotification) {
    this.emit('notification', notification);
  }

  private _emitResourceListChanged() {
    this._emitNotification({
      method: 'notifications/resources/list_changed',
      params: {},
    });
  }

  private _emitResourceUpdated(uri: string) {
    this._emitNotification({
      method: 'notifications/resources/updated',
      params: { uri },
    });
  }

  private _emitToolListChanged() {
    this._emitNotification({
      method: 'notifications/tools/list_changed',
      params: {},
    });
  }

  private _emitPromptListChanged() {
    this._emitNotification({
      method: 'notifications/prompts/list_changed',
      params: {},
    });
  }

  addTool<T>(
    name: string,
    definition: ToolDefinition<T>,
    handler: ToolHandler<T>,
  ) {
    this.logger.debug('Adding tool', { name, definition });

    this.tools.set(name, { definition, handler });
    this._emitToolListChanged();
    return this;
  }

  async listTools(): Promise<Tool[]> {
    this.logger.debug('Listing tools');

    const tools = Array.from(this.tools.entries()).map(
      ([name, { definition }]) => {
        // Always generate a simple object schema with the correct structure
        // that matches what the MCP protocol expects
        const inputSchema = {
          type: 'object' as const, // Use a const assertion to ensure type is exactly "object"
          properties: {} as Record<string, unknown>,  // Ensure this matches the expected shape
        };
        
        // Try to extract properties from the Zod schema
        try {
          const rawSchema = zodToJsonSchema(definition.schema);
          
          // Only add properties if they exist in the raw schema
          if (typeof rawSchema === 'object' && rawSchema !== null) {
            // If the schema has properties, use them
            if ('properties' in rawSchema && typeof rawSchema.properties === 'object') {
              inputSchema.properties = rawSchema.properties as Record<string, unknown>;
            }
            
            // Add required fields if present
            if ('required' in rawSchema && Array.isArray(rawSchema.required)) {
              (inputSchema as any).required = rawSchema.required;
            }
            
            // Add additionalProperties if present
            if ('additionalProperties' in rawSchema) {
              (inputSchema as any).additionalProperties = rawSchema.additionalProperties;
            }
          }
        } catch (e) {
          this.logger.error('Error converting schema to JSON', { error: e });
        }
        
        return {
          name,
          description: definition.description,
          inputSchema,
        } as Tool; // Use type assertion instead of satisfies
      },
    );

    return tools;
  }

  async callTool(name: string, args: unknown): Promise<CallToolResult> {
    this.logger.debug('Calling tool', { name, args });

    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    const { definition, handler } = tool;

    // Check if args has a format field or special format indicators
    const formatOptions = args && typeof args === 'object' && args !== null
      ? (args as Record<string, any>)
      : {};
    
    // Check if content_and_artifact format is requested
    const useContentAndArtifactFormat = 
      formatOptions.format === 'content_and_artifact' || 
      formatOptions._format === 'content_and_artifact';

    // Strip format indicators before passing to validator
    let processedArgs = args;
    if (typeof processedArgs === 'object' && processedArgs !== null) {
      const cleanedArgs = { ...processedArgs as Record<string, any> };
      delete cleanedArgs.format;
      delete cleanedArgs._format;
      processedArgs = cleanedArgs;
    }

    // Validate and process arguments
    try {
      const validatedArgs = definition.schema.parse(processedArgs);
      this.logger.debug('Tool args validated', { validatedArgs });
      
      let result = validatedArgs;
      if (definition.middlewares) {
        for (const middleware of definition.middlewares) {
          result = await middleware(result, async (modified) => modified);
        }
      }

      // Execute tool handler with processed args
      const toolResult = await handler(result);
      
      // Convert to requested format if needed
      if (useContentAndArtifactFormat) {
        // If result is already in tuple format, return as is
        if (Array.isArray(toolResult)) {
          // Need to preserve the return type for the toolResult
          return toolResult as CallToolResult;
        }
        
        // Convert object format to tuple format - this is what most LLMs expect
        const contentArray = toolResult.content || [];
        const artifactValue = toolResult.artifact || null;
        
        // Use a direct type assertion to satisfy TypeScript
        return [contentArray, artifactValue] as unknown as CallToolResult;
      }
      
      // If result is in tuple format but object format is expected, convert
      if (Array.isArray(toolResult)) {
        // Create a properly structured object response
        const objResult = {
          content: toolResult[0] || []
        } as { content: ContentItem[], isError?: boolean, artifact?: any };
        
        // Only add artifact if it's not null
        if (toolResult[1] !== null && toolResult[1] !== undefined) {
          objResult.artifact = toolResult[1];
        }
        
        return objResult;
      }
      
      return toolResult;
    } catch (error) {
      this.logger.error('Tool execution error', { error });
      throw error;
    }
  }

  addResource(uri: string, definition: ResourceDefinition) {
    this.resources.set(uri, definition);
    this._emitResourceListChanged();

    return this;
  }

  async listResources(): Promise<Resource[]> {
    const resources: Resource[] = [];

    for (const [uri, def] of this.resources) {
      const items = await def.listHandler();
      resources.push(
        ...items.map((item) => ({
          ...item,
          uri,
          name: def.name,
          description: def.description,
          mimeType: def.mimeType,
        })),
      );
    }

    return resources;
  }

  async readResource(uri: string): Promise<BlobResourceContents[]> {
    const resource = this.resources.get(uri);
    if (!resource) {
      throw new Error(`Resource not found: ${uri}`);
    }

    let result = { uri };
    if (resource.middlewares) {
      for (const middleware of resource.middlewares) {
        result = (await middleware(result, async (modified) => modified)) as {
          uri: string;
        };
      }
    }

    return resource.readHandler();
  }

  async subscribeToResource(uri: string): Promise<void> {
    if (!this.capabilities.resources?.subscribe) {
      throw new Error('Resource subscription not supported');
    }

    const resource = this.resources.get(uri);
    if (!resource) {
      throw new Error(`Resource not found: ${uri}`);
    }

    if (!resource.subscribe) {
      throw new Error(`Resource ${uri} does not support subscriptions`);
    }

    if (!this.subscriptions.has(uri)) {
      this.subscriptions.set(uri, new Set());
    }

    // biome-ignore lint/style/noNonNullAssertion: <explanation>
    this.subscriptions.get(uri)!.add(uri);
  }

  async unsubscribeFromResource(uri: string): Promise<void> {
    const subscribers = this.subscriptions.get(uri);
    if (subscribers) {
      subscribers.delete(uri);
      if (subscribers.size === 0) {
        this.subscriptions.delete(uri);
      }
    }
  }

  // Prompt methods
  addPrompt(
    name: string,
    definition: PromptDefinition,
    handler: PromptHandler,
  ) {
    this.prompts.set(name, { definition, handler });
    this._emitPromptListChanged();

    return this;
  }

  async listPrompts(): Promise<Prompt[]> {
    return Array.from(this.prompts.entries()).map(([name, { definition }]) => ({
      name,
      description: definition.description,
      arguments: definition.arguments,
    }));
  }

  async getPrompt(
    name: string,
    args: Record<string, string> = {},
  ): Promise<PromptMessage[]> {
    this.logger.debug('Getting prompt', { name, args });

    const prompt = this.prompts.get(name);
    if (!prompt) {
      const error = `Prompt not found: ${name}`;
      this.logger.error(error);
      throw new Error(error);
    }

    const { definition, handler } = prompt;

    // Validate required arguments
    if (definition.arguments) {
      for (const arg of definition.arguments) {
        if (arg.required && !(arg.name in args)) {
          const error = `Missing required argument: ${arg.name}`;
          this.logger.error(error, { name, args });
          throw new Error(error);
        }
      }
    }

    // Apply middlewares
    let modifiedArgs = args;
    if (definition.middlewares) {
      for (const middleware of definition.middlewares) {
        modifiedArgs = (await middleware(
          modifiedArgs,
          async (modified) => modified,
        )) as Record<string, string>;
      }

      this.logger.debug('Prompt middleware applied', { modifiedArgs });
    }

    const messages = await handler(modifiedArgs);
    this.logger.debug('Prompt executed successfully', {
      name,
      messageCount: messages.length,
    });
    return messages;
  }

  // Initialize handler
  async initialize(request: InitializeRequest): Promise<InitializeResult> {
    this.logger.debug('Initializing', { request });

    return {
      id: 'RemoteMCP',
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: this.capabilities,
      serverInfo: this.implementation,
    };
  }

  // Create tRPC router
  createTRPCRouter() {
    const t = initTRPC.create({
      errorFormatter({ type, path, input, shape, error }) {
        return {
          ...shape,
          data: {
            ...shape.data,
            zodError:
              error.code === 'BAD_REQUEST' && error.cause instanceof ZodError
                ? error.cause.flatten()
                : null,
          },
        };
      },
    });
    const router = t.router;
    const publicProcedure = t.procedure;
    const events = this.events;

    const appRouter = router({
      ping: publicProcedure.query(() => 'pong'),

      initialize: publicProcedure
        .input(InitializeRequestSchema)
        .output(InitializeResultSchema)
        .mutation(async ({ input }) => {
          const { params } = { params: input };
          return this.initialize(params);
        }),

      'tools/list': publicProcedure
        .input(ListToolsRequestSchema)
        .output(ListToolsResultSchema)
        .query(async ({ input }) => ({
          tools: await this.listTools(),
          // ...(input.params?.cursor && { nextCursor: input.params?.cursor }),
        })),

      'tools/call': publicProcedure
        .input(CallToolRequestSchema)
        .output(CallToolResultSchema)
        .mutation(async ({ input }) => {
          const result = await this.callTool(input.params.name, input.params.arguments);
          
          // Ensure we always return in the format expected by the schema
          if (Array.isArray(result)) {
            // Convert tuple format to object format for MCP protocol compatibility
            return {
              content: result[0],
              ...(result[1] !== null && { artifact: result[1] })
            };
          }
          
          return result;
        }),

      // Resources endpoints
      'resources/list': publicProcedure
        .input(ListResourcesRequestSchema)
        .output(ListResourcesResultSchema)
        .query(async ({ input }) => ({
          resources: await this.listResources(),
        })),

      'resources/read': publicProcedure
        .input(ReadResourceRequestSchema)
        .output(ReadResourceResultSchema)
        .query(async ({ input }) => ({
          contents: await this.readResource(input.params.uri),
        })),

      'resources/subscribe': publicProcedure
        .input(SubscribeRequestSchema)
        .mutation(async ({ input }) => {
          await this.subscribeToResource(input.params.uri);
          return {};
        }),

      'resources/unsubscribe': publicProcedure
        .input(UnsubscribeRequestSchema)
        .mutation(async ({ input }) => {
          await this.unsubscribeFromResource(input.params.uri);
          return {};
        }),

      // Prompts endpoints
      'prompts/list': publicProcedure
        .input(ListPromptsRequestSchema)
        .output(ListPromptsResultSchema)
        .query(async ({ input }) => ({
          prompts: await this.listPrompts(),
          // ...(input?.cursor && { nextCursor: input.cursor }),
        })),

      'prompts/get': publicProcedure
        .input(GetPromptRequestSchema)
        .output(GetPromptResultSchema)
        .query(async ({ input }) => ({
          messages: await this.getPrompt(
            input.params.name,
            input.params.arguments,
          ),
        })),

      'notifications/stream': publicProcedure.subscription(async function* () {
        try {
          for await (const event of on(events, 'notification', {
            signal: undefined,
          })) {
            yield* event;
          }
        } finally {
        }
      }),
    });

    return appRouter;
  }
}

interface Events {
  resourceListChanged: () => void;
  resourceUpdated: (uri: string) => void;
  toolListChanged: () => void;
  promptListChanged: () => void;
  rootsListChanged: () => void;
}
