/**
 * Agent Service - 外部Agentサーバー（ollama.gitpullpull.me）との連携
 *
 * 処理フロー:
 * 1. Google Maps Places APIで周辺店舗を取得
 * 2. 店舗リストを外部Agentサーバーに送信
 * 3. Agentが各店舗の学割情報をWeb検索で調査
 * 4. 結果を整形して返却
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

export interface AgentRequest {
  shops: AgentShop[];
  location: {
    lat: number;
    lng: number;
  };
}

export interface AgentResultItem {
  place_id: string;
  name: string;
  has_gakuwari: boolean;
  discount_info: string;
  source_url: string;
  confidence: "high" | "medium" | "low";
}

export interface AgentResponse {
  results: AgentResultItem[];
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

  // 各店舗のwebsite情報を取得（Place Details API）
  const shopsWithDetails = await Promise.all(
    shops.slice(0, 20).map(async (shop) => {
      try {
        const details = await makeRequest<PlaceDetailsResult>(
          "/maps/api/place/details/json",
          {
            place_id: shop.place_id,
            fields: "website",
            language: "ja",
          },
        );
        if (details.status === "OK" && details.result?.website) {
          return { ...shop, website: details.result.website };
        }
      } catch {
        // website取得失敗は無視
      }
      return shop;
    }),
  );

  return shopsWithDetails;
}

// ============================================================================
// Agent Server Communication
// ============================================================================

/**
 * 外部Agentサーバーに店舗リストを送信して学割情報を取得する
 */
export async function callAgentServer(
  shops: AgentShop[],
  location: { lat: number; lng: number },
): Promise<AgentResultItem[]> {
  const agentUrl = process.env.OLLAMA_AGENT_URL;
  const apiKey = process.env.OLLAMA_API_KEY;

  if (!agentUrl || !apiKey) {
    throw new Error("OLLAMA_AGENT_URL and OLLAMA_API_KEY must be set");
  }

  const requestBody: AgentRequest = {
    shops: shops.map((s) => ({
      name: s.name,
      address: s.address,
      place_id: s.place_id,
      website: s.website,
    })) as AgentShop[],
    location,
  };

  const response = await fetch(`${agentUrl}/api/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(120_000), // 2分タイムアウト（Agent処理は時間がかかる）
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Agent server error (${response.status}): ${errorText}`,
    );
  }

  const data = (await response.json()) as AgentResponse;
  return data.results || [];
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
  const shops = await searchNearbyPlaces(lat, lng, radius, keyword);

  if (shops.length === 0) {
    return [];
  }

  // 2. Agentサーバーに送信して学割情報を取得
  let agentResults: AgentResultItem[];
  try {
    agentResults = await callAgentServer(shops, { lat, lng });
  } catch (error) {
    console.error("[Agent] Failed to call agent server:", error);
    // Agentサーバーが利用不可の場合、店舗情報のみ返す
    return shops.map((shop) => ({
      place_id: shop.place_id,
      name: shop.name,
      address: shop.address,
      lat: shop.lat,
      lng: shop.lng,
      rating: shop.rating,
      website: shop.website,
      types: shop.types,
      has_gakuwari: false,
      discount_info: "",
      source_url: "",
      confidence: "low" as const,
    }));
  }

  // 3. Places結果とAgent結果をマージ
  const agentMap = new Map(
    agentResults.map((r) => [r.place_id, r]),
  );

  return shops.map((shop) => {
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
