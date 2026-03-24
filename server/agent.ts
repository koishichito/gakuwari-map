/**
 * Agent Service - Ollama + SearXNG によるAgentループ実装
 *
 * 処理フロー:
 * 1. Google Maps Places APIで周辺店舗を取得
 * 2. 各店舗についてOllama /api/chatにtool定義付きで問い合わせ
 * 3. Ollamaがtool_callsを返す → SearXNG(searxng.gitpullpull.me)でWeb検索実行
 * 4. 検索結果をOllamaに返して最終回答を取得
 * 5. 結果を整形して返却
 */

import { makeRequest, type PlacesSearchResult, type PlaceDetailsResult } from "./_core/map";

// ============================================================================
// Types
// ============================================================================

export interface AgentShop {
  name: string;
  address: string;
  place_id: string;
  website?: string;
  lat: number;
  lng: number;
  rating?: number;
  types?: string[];
}

export interface AgentResultItem {
  place_id: string;
  name: string;
  has_gakuwari: boolean;
  discount_info: string;
  source_url: string;
  confidence: "high" | "medium" | "low";
}

export interface GakuwariSearchResult {
  place_id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  rating?: number;
  website?: string;
  types?: string[];
  has_gakuwari: boolean;
  discount_info: string;
  source_url: string;
  confidence: "high" | "medium" | "low";
}

// Ollama API types
interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
}

// SearXNG types
interface SearXNGResult {
  title: string;
  url: string;
  content: string;
}

interface SearXNGResponse {
  results: SearXNGResult[];
}

// ============================================================================
// Configuration
// ============================================================================

const OLLAMA_URL = process.env.OLLAMA_AGENT_URL || "https://ollama.gitpullpull.me";
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "";
const SEARXNG_URL = "https://searxng.gitpullpull.me";
const OLLAMA_MODEL = "qwen3.5:27b";
const MAX_AGENT_LOOPS = 3; // tool_callsの最大ループ回数
const OLLAMA_TIMEOUT = 120_000; // 2分タイムアウト
const MAX_SHOPS = 5; // Agent調査する最大店舗数（504タイムアウト対策）

// ============================================================================
// System Prompt & Tools
// ============================================================================

const SYSTEM_PROMPT = `あなたは店舗の学割情報を調査するエージェントです。
与えられた店舗名についてweb_searchツールを使って学割・学生割引情報を調べてください。

調査手順:
1. まず「店舗名 学割」「店舗名 学生割引」などで検索してください
2. 検索結果から学割情報を確認してください
3. 情報が見つからない場合は、チェーン店名（例: スターバックス、マクドナルド）で「チェーン名 学割」と検索してください

最終的に以下のJSON形式で回答してください（JSONのみ、他のテキストは不要）:
{"has_gakuwari": true/false, "discount_info": "学割の具体的な内容", "source_url": "情報源のURL", "confidence": "high/medium/low"}

- has_gakuwari: 学割があるかどうか
- discount_info: 学割の具体的な内容（例: 「学生証提示でドリンク10%OFF」）。ない場合は空文字
- source_url: 情報源のURL。ない場合は空文字
- confidence: 情報の信頼度。公式サイトや信頼できるソースからの情報は"high"、口コミやまとめサイトは"medium"、推測は"low"`;

const TOOLS_DEFINITION = [
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description: "Web検索を行う。店舗の学割・学生割引情報を調べるために使う。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "検索クエリ",
          },
        },
        required: ["query"],
      },
    },
  },
];

// ============================================================================
// SearXNG Search
// ============================================================================

/**
 * SearXNGでWeb検索を実行する
 */
async function searxngSearch(query: string): Promise<string> {
  try {
    const params = new URLSearchParams({ q: query, format: "json" });
    const response = await fetch(`${SEARXNG_URL}/search?${params.toString()}`, {
      method: "GET",
      headers: {
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      console.warn(`[SearXNG] Search failed (${response.status}): ${query}`);
      return `検索エラー: ステータス ${response.status}`;
    }

    const data = (await response.json()) as SearXNGResponse;
    const results = data.results || [];

    if (results.length === 0) {
      return "検索結果が見つかりませんでした。";
    }

    // 上位5件を整形して返す
    const formatted = results.slice(0, 5).map((r, i) => {
      return `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content || "(内容なし)"}`;
    }).join("\n\n");

    return formatted;
  } catch (error) {
    console.error("[SearXNG] Search error:", error);
    return `検索エラー: ${error instanceof Error ? error.message : "不明なエラー"}`;
  }
}

// ============================================================================
// Ollama Agent Loop
// ============================================================================

/**
 * 1店舗についてAgentループを実行する
 */
async function runAgentForShop(shop: AgentShop): Promise<AgentResultItem> {
  const userMessage = `「${shop.name}」（住所: ${shop.address || "不明"}）の学割情報を調べてください。`;

  const messages: OllamaMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ];

  let loopCount = 0;

  while (loopCount < MAX_AGENT_LOOPS) {
    loopCount++;
    console.log(`[Agent] Shop "${shop.name}" - Loop ${loopCount}`);

    try {
      // Ollamaに問い合わせ
      const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OLLAMA_API_KEY}`,
        },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages,
          tools: TOOLS_DEFINITION,
          stream: false,
          keep_alive: -1,
          think: false,
        }),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Agent] Ollama error (${response.status}): ${errorText.slice(0, 500)}`);
        throw new Error(`Ollama error: ${response.status}`);
      }

      // Guard against non-JSON responses (e.g., Cloudflare 502 HTML pages)
      const responseText = await response.text();
      let data: OllamaChatResponse;
      try {
        data = JSON.parse(responseText) as OllamaChatResponse;
      } catch {
        console.error(`[Agent] Non-JSON response from Ollama: ${responseText.slice(0, 300)}`);
        throw new Error(`Ollama returned non-JSON response`);
      }
      const assistantMessage = data.message;

      // メッセージ履歴に追加
      messages.push(assistantMessage);

      // tool_callsがなければ最終回答
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        console.log(`[Agent] Shop "${shop.name}" - Final answer received`);
        return parseAgentResult(shop, assistantMessage.content);
      }

      // tool_callsを実行
      for (const toolCall of assistantMessage.tool_calls) {
        const funcName = toolCall.function.name;
        const args = toolCall.function.arguments;

        if (funcName === "web_search") {
          const query = (args.query as string) || `${shop.name} 学割`;
          console.log(`[Agent] Shop "${shop.name}" - Searching: "${query}"`);

          const searchResult = await searxngSearch(query);

          // tool結果をメッセージに追加
          messages.push({
            role: "tool",
            content: searchResult,
          });
        } else {
          console.warn(`[Agent] Unknown tool: ${funcName}`);
          messages.push({
            role: "tool",
            content: `Unknown tool: ${funcName}`,
          });
        }
      }
    } catch (error) {
      console.error(`[Agent] Error in loop ${loopCount} for "${shop.name}":`, error);

      // タイムアウトやネットワークエラーの場合、デフォルト結果を返す
      return {
        place_id: shop.place_id,
        name: shop.name,
        has_gakuwari: false,
        discount_info: "",
        source_url: "",
        confidence: "low",
      };
    }
  }

  // 最大ループ回数に達した場合
  console.warn(`[Agent] Max loops reached for "${shop.name}"`);
  const lastMessage = messages[messages.length - 1];
  if (lastMessage && lastMessage.role === "assistant" && lastMessage.content) {
    return parseAgentResult(shop, lastMessage.content);
  }

  return {
    place_id: shop.place_id,
    name: shop.name,
    has_gakuwari: false,
    discount_info: "",
    source_url: "",
    confidence: "low",
  };
}

// ============================================================================
// Result Parser
// ============================================================================

/**
 * Ollamaの最終回答をパースしてAgentResultItemに変換する
 */
function parseAgentResult(shop: AgentShop, content: string): AgentResultItem {
  const defaultResult: AgentResultItem = {
    place_id: shop.place_id,
    name: shop.name,
    has_gakuwari: false,
    discount_info: "",
    source_url: "",
    confidence: "low",
  };

  if (!content || content.trim() === "") {
    return defaultResult;
  }

  try {
    // JSONを抽出（コードブロックやテキストに埋め込まれている場合も対応）
    let jsonStr = content.trim();

    // ```json ... ``` ブロックを抽出
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    // { ... } を抽出
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    const parsed = JSON.parse(jsonStr);

    return {
      place_id: shop.place_id,
      name: shop.name,
      has_gakuwari: Boolean(parsed.has_gakuwari),
      discount_info: String(parsed.discount_info || ""),
      source_url: String(parsed.source_url || ""),
      confidence: (["high", "medium", "low"].includes(parsed.confidence)
        ? parsed.confidence
        : "low") as "high" | "medium" | "low",
    };
  } catch (error) {
    console.warn(`[Agent] Failed to parse result for "${shop.name}":`, content.slice(0, 200));

    // テキストから学割情報を推測
    const hasGakuwari = /学割|学生割引|学生証|student.?discount/i.test(content)
      && !/学割.*(?:なし|ない|ありません|見つかりません|確認できません)/i.test(content);

    return {
      ...defaultResult,
      has_gakuwari: hasGakuwari,
      discount_info: hasGakuwari ? content.slice(0, 200) : "",
      confidence: "low",
    };
  }
}

// ============================================================================
// Google Maps Places API - 周辺店舗取得
// ============================================================================

/**
 * Google Maps Places APIで周辺店舗を取得する
 */
export async function searchNearbyPlaces(
  lat: number,
  lng: number,
  radius: number = 500,
  keyword?: string,
  type?: string,
): Promise<AgentShop[]> {
  const params: Record<string, unknown> = {
    location: `${lat},${lng}`,
    radius,
    language: "ja",
  };

  if (keyword) params.keyword = keyword;
  if (type) params.type = type;

  const result = await makeRequest<PlacesSearchResult>(
    "/maps/api/place/nearbysearch/json",
    params,
  );

  if (result.status !== "OK" && result.status !== "ZERO_RESULTS") {
    throw new Error(`Places API error: ${result.status}`);
  }

  const shops: AgentShop[] = (result.results || []).map((place) => ({
    name: place.name,
    address: place.formatted_address,
    place_id: place.place_id,
    lat: place.geometry.location.lat,
    lng: place.geometry.location.lng,
    rating: place.rating,
    types: place.types,
  }));

  return shops;
}

// ============================================================================
// Combined Search Flow
// ============================================================================

/**
 * 周辺店舗を検索し、Agentで学割情報を調査する統合フロー
 */
export async function searchGakuwariSpots(
  lat: number,
  lng: number,
  radius: number = 500,
  keyword?: string,
): Promise<GakuwariSearchResult[]> {
  // 1. Google Maps Places APIで周辺店舗を取得
  console.log(`[Agent] Searching nearby places: lat=${lat}, lng=${lng}, radius=${radius}`);
  const shops = await searchNearbyPlaces(lat, lng, radius, keyword);

  if (shops.length === 0) {
    console.log("[Agent] No shops found nearby");
    return [];
  }

  console.log(`[Agent] Found ${shops.length} shops, starting agent investigation...`);

  // 2. 各店舗についてAgentループを実行（並列、最大MAX_SHOPS件）
  const targetShops = shops.slice(0, MAX_SHOPS);
  const batchSize = MAX_SHOPS; // 全件並列実行で高速化
  const allResults: AgentResultItem[] = [];

  for (let i = 0; i < targetShops.length; i += batchSize) {
    const batch = targetShops.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((shop) => runAgentForShop(shop)),
    );
    allResults.push(...batchResults);
    console.log(`[Agent] Completed ${Math.min(i + batchSize, targetShops.length)}/${targetShops.length} shops`);
  }

  // 3. Places結果とAgent結果をマージ
  const agentMap = new Map(allResults.map((r) => [r.place_id, r]));

  // Agent調査済みの店舗のみ返す
  return targetShops.map((shop) => {
    const agentResult = agentMap.get(shop.place_id);
    return {
      place_id: shop.place_id,
      name: agentResult?.name || shop.name,
      address: shop.address,
      lat: shop.lat,
      lng: shop.lng,
      rating: shop.rating,
      website: shop.website,
      types: shop.types,
      has_gakuwari: agentResult?.has_gakuwari ?? false,
      discount_info: agentResult?.discount_info ?? "",
      source_url: agentResult?.source_url ?? "",
      confidence: agentResult?.confidence ?? "low",
    };
  });
}
