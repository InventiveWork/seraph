import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  // This is a placeholder for a real MCP server command.
  // In a real scenario, you would replace this with the actual command
  // to start the MCP server you want to connect to.
  // For now, we'll just use a command that will exit gracefully.
  const transport = new StdioClientTransport({
    command: "node",
    args: ["-e", "console.log('MCP server started');"],
  });

  const client = new Client({
    name: "example-client",
    version: "1.0.0",
  });

  await client.connect(transport);

  console.log("Connected to MCP server.");

  // We can't list tools without a real server,
  // but this is how you would do it:
  // const tools = await client.listTools();
  // console.log("Available tools:", tools);

  await client.close();
}

main().catch(console.error);