import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT_ID = process.env.AD_ACCOUNT_ID || "act_983918154109101";
const MCP_SERVER_KEY = process.env.MCP_SERVER_KEY || "";

const GRAPH_VERSION = "v25.0";

function requireEnv() {
  if (!META_ACCESS_TOKEN) {
    throw new Error("Missing META_ACCESS_TOKEN environment variable");
  }
}

async function fetchMetaInsights({ level, datePreset = "last_7d", limit = 50 }) {
  requireEnv();

  const fieldsByLevel = {
    campaign:
      "campaign_name,spend,impressions,reach,frequency,clicks,ctr,cpc,cpm,actions",
    adset:
      "campaign_name,adset_name,spend,impressions,reach,frequency,clicks,ctr,cpc,cpm,actions",
    ad:
      "campaign_name,adset_name,ad_name,spend,impressions,reach,frequency,clicks,ctr,cpc,cpm,actions"
  };

  const url = new URL(
    `https://graph.facebook.com/${GRAPH_VERSION}/${AD_ACCOUNT_ID}/insights`
  );

  url.searchParams.set("fields", fieldsByLevel[level]);
  url.searchParams.set("date_preset", datePreset);
  url.searchParams.set("level", level);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("access_token", META_ACCESS_TOKEN);

  const response = await fetch(url);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Meta API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data;
}

function createMcpServer() {
  const server = new McpServer({
    name: "azdan-meta-ads-mcp",
    version: "1.0.0"
  });

  server.registerTool(
    "get_campaign_insights",
    {
      description: "Get AZDAN Meta Ads campaign insights. Read-only.",
      inputSchema: {
        datePreset: z.string().default("last_7d"),
        limit: z.number().int().min(1).max(100).default(50)
      }
    },
    async ({ datePreset, limit }) => {
      const data = await fetchMetaInsights({
        level: "campaign",
        datePreset,
        limit
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2)
          }
        ]
      };
    }
  );

  server.registerTool(
    "get_adset_insights",
    {
      description: "Get AZDAN Meta Ads ad set insights. Read-only.",
      inputSchema: {
        datePreset: z.string().default("last_7d"),
        limit: z.number().int().min(1).max(100).default(50)
      }
    },
    async ({ datePreset, limit }) => {
      const data = await fetchMetaInsights({
        level: "adset",
        datePreset,
        limit
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2)
          }
        ]
      };
    }
  );

  server.registerTool(
    "get_ad_insights",
    {
      description: "Get AZDAN Meta Ads ad-level insights. Read-only.",
      inputSchema: {
        datePreset: z.string().default("last_7d"),
        limit: z.number().int().min(1).max(100).default(50)
      }
    },
    async ({ datePreset, limit }) => {
      const data = await fetchMetaInsights({
        level: "ad",
        datePreset,
        limit
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2)
          }
        ]
      };
    }
  );

  return server;
}

function checkMcpKey(req, res, next) {
  if (!MCP_SERVER_KEY) return next();

  const keyFromHeader = req.get("x-api-key");
  const keyFromQuery = req.query.key;

  if (keyFromHeader === MCP_SERVER_KEY || keyFromQuery === MCP_SERVER_KEY) {
    return next();
  }

  return res.status(401).json({
    error: "Unauthorized"
  });
}

app.get("/", (req, res) => {
  res.json({
    name: "AZDAN Meta Ads MCP Server",
    status: "ok",
    mode: "read-only"
  });
});

const transports = {};

app.post("/mcp", checkMcpKey, async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports[newSessionId] = transport;
        }
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
        }
      };

      const server = createMcpServer();
      await server.connect(transport);
    } else {
      return res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided"
        },
        id: null
      });
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.status(500).json({
        error: error.message
      });
    }
  }
});

app.get("/mcp", checkMcpKey, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send("Invalid or missing MCP session ID");
  }

  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
});

app.delete("/mcp", checkMcpKey, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send("Invalid or missing MCP session ID");
  }

  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
});

app.listen(PORT, () => {
  console.log(`AZDAN Meta Ads MCP Server running on port ${PORT}`);
});
