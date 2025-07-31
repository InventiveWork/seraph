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

  public async initialize(serverUrl: string) {
    try {
      const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
      this.client = new Client({
        name: "seraph-client",
        version: "1.0.0",
      });

      await this.client.connect(transport);
      console.log(`Successfully connected to MCP server at ${serverUrl}`);

      this.tools = await this.client.listTools();
      if (!Array.isArray(this.tools)) {
        console.log("Warning: The MCP server did not return a valid list of tools. Proceeding without external tools.");
        this.tools = []; // Ensure this.tools is always an array
      }
      console.log(`Discovered ${this.tools.length} tools.`);
    } catch (error) {
      console.log("MCP server currently not available.");
      // Ensure client is null if connection fails
      this.client = null;
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