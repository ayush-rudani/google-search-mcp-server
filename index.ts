import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { RateLimiter } from "limiter";

const GOOGLE_SEARCH_TOOL: Tool = {
  name: "google_search",
  description:
    "Search Google and return relevant results from the web. This tool finds web pages, articles, and information on specific topics using Google's search engine. Results include titles, snippets, and URLs that can be analyzed further using extract_webpage_content.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The search term or phrase to look up. For precise results: use quotes for exact phrases, include relevant keywords, and keep queries concise (under 10 words ideal). Example: 'best Italian restaurants in Boston' or 'how to fix leaking faucet'.",
      },
      num_results: {
        type: "number",
        description:
          "Controls the number of search results returned (range: 1-10). Default: 5. Higher values provide more comprehensive results but may take slightly longer. Lower values return faster but with less coverage.",
      },
      date_restrict: {
        type: "string",
        description:
          'Filters results by recency. Format: [d|w|m|y] + number. Examples: "d1" (last 24 hours), "w1" (last week), "m6" (last 6 months), "y1" (last year). Useful for time-sensitive queries like news or recent developments.',
      },
      language: {
        type: "string",
        description:
          'Limits results to a specific language. Provide 2-letter ISO code. Common options: "en" (English), "es" (Spanish), "fr" (French), "de" (German), "ja" (Japanese), "zh" (Chinese). Helps filter non-relevant language results.',
      },
      country: {
        type: "string",
        description:
          'Narrows results to a specific country. Provide 2-letter country code. Examples: "us" (USA), "gb" (UK), "ca" (Canada), "in" (India), "au" (Australia). Useful for location-specific services or information.',
      },
      safe_search: {
        type: "string",
        enum: ["off", "medium", "high"],
        description:
          'Content safety filter level. "off" = no filtering, "medium" = blocks explicit images/videos, "high" = strict filtering for all content. Recommended: "medium" for general use, "high" for child-safe environments.',
      },
    },
    required: ["query"],
  },
};

const server = new Server(
  {
    name: "google-search",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
if (!GOOGLE_API_KEY) {
  throw new Error("GOOGLE_API_KEY environment variable is not set");
}

const GOOGLE_SEARCH_ENGINE_ID = process.env.GOOGLE_SEARCH_ENGINE_ID;
if (!GOOGLE_SEARCH_ENGINE_ID) {
  throw new Error("GOOGLE_SEARCH_ENGINE_ID environment variable is not set");
}

const RATE_LIMIT = {
  perMinute: 10,
};

const minuteLimiter = new RateLimiter({
  tokensPerInterval: RATE_LIMIT.perMinute,
  interval: "minute",
});

async function checkRateLimit() {
  const remainingTokens = await minuteLimiter.removeTokens(1);

  if (remainingTokens < 0) {
    throw new Error("Rate limit exceeded");
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [GOOGLE_SEARCH_TOOL],
}));

interface GoogleCustomSearchResponse {
  kind: string;
  url: {
    type: string;
    template: string;
  };
  context?: {
    title: string;
  };
  searchInformation: {
    searchTime: number;
    formattedSearchTime: string;
    totalResults: string;
    formattedTotalResults: string;
  };
  items?: Array<{
    kind: string;
    title: string;
    htmlTitle: string;
    link: string;
    displayLink: string;
    snippet: string;
    htmlSnippet: string;
    formattedUrl: string;
    htmlFormattedUrl: string;
    pagemap?: {
      hcard?: Array<{
        fn?: string;
        photo?: string;
        url?: string;
      }>;
      cse_thumbnail?: Array<{
        src: string;
        width: string;
        height: string;
      }>;
      metatags?: Array<Record<string, string>>;
      cse_image?: Array<{
        src: string;
      }>;
      [key: string]: any;
    };
  }>;
}

function verifyGoogleSearchArgs(
  args: Record<string, unknown>
): asserts args is {
  query: string;
  num_results?: number;
  date_restrict?: string;
  language?: string;
  country?: string;
  safe_search?: "off" | "medium" | "high";
} {
  if (
    !(
      typeof args === "object" &&
      args !== null &&
      typeof args.query === "string"
    )
  ) {
    throw new Error("Invalid arguments for Google search");
  }
}

async function performGoogleSearch(
  query: string,
  count: number,
  dateRestrict?: string,
  language?: string,
  country?: string,
  safeSearch?: "off" | "medium" | "high"
): Promise<string> {
  checkRateLimit();
  if (!GOOGLE_API_KEY || !GOOGLE_SEARCH_ENGINE_ID) {
    throw new Error("Missing required Google API configuration");
  }
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", GOOGLE_API_KEY);
  url.searchParams.set("cx", GOOGLE_SEARCH_ENGINE_ID);
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(count));

  const params = [
    { key: "dateRestrict", value: dateRestrict },
    { key: "lr", value: language && `lang_${language}` },
    { key: "gl", value: country },
    { key: "safe", value: safeSearch },
  ];

  params.forEach(({ key, value }) => {
    if (value) url.searchParams.set(key, value);
  });

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Google Search API error: ${response.statusText}`);
  }

  const data = (await response.json()) as GoogleCustomSearchResponse;

  if (!data.items || data.items.length === 0) {
    return "No results found";
  }

  const results = data.items;
  const formattedResults = results
    .map((item) => {
      return `Title: ${item.title}\nURL: ${item.link}\nDescription: ${item.snippet}`;
    })
    .join("\n\n");

  return `Found ${results.length} results:\n\n${formattedResults}`;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    if (!args) {
      throw new Error("No arguments provided");
    }

    switch (name) {
      case "google_search": {
        verifyGoogleSearchArgs(args);
        const { query, num_results: count = 10 } = args;
        const results = await performGoogleSearch(
          query,
          count,
          args.date_restrict,
          args.language,
          args.country,
          args.safe_search
        );
        return {
          content: [{ type: "text", text: results }],
          isError: false,
        };
      }
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
      isError: true,
    };
  }
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Google Search MCP Server running on stdio");
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
