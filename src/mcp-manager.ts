import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface AgentTool {
  name: string;
  description: string;
  execute: (args: Record<string, any>) => Promise<any>;
}

class McpManager {
  private client: Client | null = null;
  private tools: any = null;
  private isConnecting: boolean = false;
  private retryCount: number = 0;
  private readonly MAX_RETRIES = 5;
  private readonly RETRY_DELAY_MS = 5000; // 5 seconds

  public async initialize(serverUrl: string) {
    if (this.isConnecting) {
      console.log("Already attempting to connect to MCP server.");
      return;
    }

    this.isConnecting = true;
    try {
      const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
      this.client = new Client({
        name: "seraph-client",
        version: "1.0.0",
      });

      await this.client.connect(transport);
      console.log(`Successfully connected to MCP server at ${serverUrl}`);
      this.retryCount = 0; // Reset retry count on successful connection

      this.tools = await this.client.listTools();
      if (!Array.isArray(this.tools)) {
        console.log("Warning: The MCP server did not return a valid list of tools. Proceeding without external tools.");
        this.tools = []; // Ensure this.tools is always an array
      }
      console.log(`Discovered ${this.tools.length} tools.`);
    } catch (error: any) {
      this.client = null; // Ensure client is null if connection fails
      console.log(`Failed to connect to MCP server at ${serverUrl}: ${error.message}`);
      
      if (this.retryCount < this.MAX_RETRIES) {
        this.retryCount++;
        console.log(`Retrying connection to MCP server in ${this.RETRY_DELAY_MS / 1000}s (Attempt ${this.retryCount}/${this.MAX_RETRIES})...`);
        setTimeout(() => this.initialize(serverUrl), this.RETRY_DELAY_MS);
      } else {
        console.log(`Max retry attempts reached for MCP server connection. Giving up.`);
      }
    } finally {
      this.isConnecting = false;
    }
  }

  public getDynamicTools(): AgentTool[] {
    if (!this.client || !this.tools) {
      return [];
    }

    const dynamicTools: AgentTool[] = [];
    for (const tool of this.tools) {
      dynamicTools.push({
        name: tool.name,
        description: tool.description || "",
        execute: async (args: Record<string, any>) => {
          if (!this.client) {
            throw new Error("MCP client is not initialized.");
          }

          // --- Start: Input Validation for Tool Arguments (Security Critical) ---
          // This is a basic validation. For production, consider a more robust schema validation
          // if the MCP server provides tool argument schemas.
          if (typeof args !== 'object' || args === null) {
            throw new Error(`Invalid arguments for tool ${tool.name}: arguments must be an object.`);
          }

          for (const key in args) {
            if (Object.prototype.hasOwnProperty.call(args, key)) {
              const value = args[key];
              // Allow primitive types, and simple arrays/objects (but not functions or complex types)
              if (typeof value === 'function' || (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) {
                throw new Error(`Invalid argument type for key '${key}' in tool ${tool.name}: complex types are not allowed.`);
              }
            }
          }
          // --- End: Input Validation for Tool Arguments ---

          return this.client.callTool({
            name: tool.name,
            arguments: args,
          });
        },
      });
    }
    return dynamicTools;
  }

  public async close() {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}

export const mcpManager = new McpManager();