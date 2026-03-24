import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { MemphisBackground } from "@/components/MemphisDecorations";
import { SpotCard } from "@/components/SpotCard";
import { CategoryIcon, getCategoryBgColor } from "@/components/CategoryIcon";
import { MapView } from "@/components/Map";
import { MapPin, Search, ArrowRight, Sparkles, Navigation, Loader2, LocateFixed } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// Default location: Tokyo
const DEFAULT_LOCATION = { lat: 35.6812, lng: 139.7671 };

type GeoState = "idle" | "loading" | "success" | "denied" | "error";

export default function Home() {
  const [, navigate] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [geoState, setGeoState] = useState<GeoState>("idle");
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const userMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);

  // Auto-request geolocation on mount
  useEffect(() => {
    if (!navigator.geolocation) {
      setGeoState("error");
      return;
    }
    setGeoState("loading");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserLocation(loc);
        setGeoState("success");
      },
      (err) => {
        console.warn("[Geolocation] Failed:", err.message);
        if (err.code === err.PERMISSION_DENIED) {
          setGeoState("denied");
        } else {
          setGeoState("error");
        }
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  }, []);

  // Manual retry for location
  const retryLocation = useCallback(() => {
    if (!navigator.geolocation) {
      toast.error("お使いのブラウザは位置情報に対応していません。");
      return;
    }
    setGeoState("loading");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserLocation(loc);
        setGeoState("success");
        if (mapRef.current) {
          mapRef.current.setCenter(loc);
          mapRef.current.setZoom(14);
        }
        toast.success("現在地を取得しました！");
      },
      () => {
        setGeoState("denied");
        toast.error("位置情報の取得に失敗しました。ブラウザの設定を確認してください。");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }, []);

  const { data: categoriesData } = trpc.category.list.useQuery();
  const categories = categoriesData ?? [];

  // Query center: user location if available, otherwise default
  const queryCenter = userLocation ?? DEFAULT_LOCATION;
  const searchRadius = userLocation ? 10 : 50; // Tighter radius when we have real location

  const { data: nearbyData, isLoading: nearbyLoading } = trpc.spot.nearby.useQuery({
    lat: queryCenter.lat,
    lng: queryCenter.lng,
    radiusKm: searchRadius,
    limit: 20,
  });

  const nearbySpots = nearbyData ?? [];

  // Build category lookup
  const categoryMap = useMemo(() => {
    const map = new Map<number, (typeof categories)[0]>();
    categories.forEach((c) => map.set(c.id, c));
    return map;
  }, [categories]);

  // Map ready handler
  const handleMapReady = useCallback((map: google.maps.Map) => {
    mapRef.current = map;
  }, []);

  // Update spot markers when data changes
  useEffect(() => {
    if (!mapRef.current || nearbySpots.length === 0) return;

    // Clear old markers
    markersRef.current.forEach((m) => (m.map = null));
    markersRef.current = [];

    const bounds = new google.maps.LatLngBounds();

    nearbySpots.forEach((spot) => {
      const lat = typeof spot.lat === "string" ? parseFloat(spot.lat) : spot.lat;
      const lng = typeof spot.lng === "string" ? parseFloat(spot.lng) : spot.lng;
      if (isNaN(lat) || isNaN(lng)) return;

      const cat = categoryMap.get(spot.categoryId);
      const pinColor =
        cat?.color === "mint" ? "#6ee7b7" :
        cat?.color === "lilac" ? "#c4b5fd" :
        cat?.color === "yellow" ? "#fde047" :
        cat?.color === "coral" ? "#fb923c" :
        cat?.color === "pink" ? "#f9a8d4" :
        "#fde047";

      const pinEl = document.createElement("div");
      pinEl.style.cssText = `width:32px;height:32px;border-radius:50%;background:${pinColor};border:2px solid #1a1a1a;display:flex;align-items:center;justify-content:center;font-size:14px;cursor:pointer;box-shadow:2px 2px 0px #1a1a1a;transition:transform 0.15s;`;
      pinEl.textContent = "🎓";
      pinEl.onmouseenter = () => { pinEl.style.transform = "scale(1.2)"; };
      pinEl.onmouseleave = () => { pinEl.style.transform = "scale(1)"; };

      const marker = new google.maps.marker.AdvancedMarkerElement({
        map: mapRef.current!,
        position: { lat, lng },
        title: spot.name,
        content: pinEl,
      });

      const infoWindow = new google.maps.InfoWindow({
        content: `<div style="font-family:'Noto Sans JP',Poppins,sans-serif;padding:6px;max-width:220px;">
          <strong style="font-size:14px;">${spot.name}</strong>
          <p style="font-size:12px;color:#666;margin:4px 0;">${spot.discountDetail}</p>
          ${spot.discountRate ? `<span style="background:#fde047;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600;">${spot.discountRate}</span>` : ""}
          ${(spot as any).distance != null ? `<p style="font-size:11px;color:#888;margin-top:4px;">📍 ${(spot as any).distance < 1 ? `${Math.round((spot as any).distance * 1000)}m` : `${(spot as any).distance.toFixed(1)}km`}</p>` : ""}
        </div>`,
      });

      marker.addListener("click", () => {
        infoWindow.open({ anchor: marker, map: mapRef.current });
      });

      markersRef.current.push(marker);
      bounds.extend({ lat, lng });
    });

    // Include user location in bounds if available
    if (userLocation) {
      bounds.extend(userLocation);
    }

    if (nearbySpots.length > 0) {
      mapRef.current.fitBounds(bounds, { top: 50, right: 50, bottom: 50, left: 50 });
    }
  }, [nearbySpots, categoryMap, userLocation]);

  // User location marker (blue dot)
  useEffect(() => {
    if (!mapRef.current || !userLocation) return;

    // Remove old user marker
    if (userMarkerRef.current) {
      userMarkerRef.current.map = null;
    }

    const userPinEl = document.createElement("div");
    userPinEl.style.cssText = `
      width: 18px; height: 18px; border-radius: 50%;
      background: #3b82f6; border: 3px solid white;
      box-shadow: 0 0 10px rgba(59,130,246,0.5), 0 0 20px rgba(59,130,246,0.2);
    `;

    const userMarker = new google.maps.marker.AdvancedMarkerElement({
      map: mapRef.current,
      position: userLocation,
      title: "現在地",
      content: userPinEl,
    });

    userMarkerRef.current = userMarker;

    return () => {
      userMarker.map = null;
    };
  }, [userLocation]);

  // Center map on user location when it becomes available
  useEffect(() => {
    if (mapRef.current && userLocation) {
      mapRef.current.setCenter(userLocation);
      mapRef.current.setZoom(14);
    }
  }, [userLocation]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

  // Location status banner
  const renderLocationBanner = () => {
    if (geoState === "loading") {
      return (
        <div className="flex items-center justify-center gap-2 py-3 px-4 bg-memphis-mint/20 border-2 border-memphis-mint/40 rounded-xl mb-4 animate-pulse">
          <Loader2 size={16} className="animate-spin text-primary" />
          <span className="text-sm font-medium">現在地を取得中...</span>
        </div>
      );
    }
    if (geoState === "denied" || geoState === "error") {
      return (
        <div className="flex items-center justify-between py-3 px-4 bg-memphis-yellow/20 border-2 border-memphis-yellow/40 rounded-xl mb-4">
          <div className="flex items-center gap-2">
            <MapPin size={16} className="text-memphis-coral" />
            <span className="text-sm font-medium">
              {geoState === "denied"
                ? "位置情報が許可されていません"
                : "位置情報を取得できませんでした"}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="memphis-btn text-xs bg-memphis-mint/30 h-8"
            onClick={retryLocation}
          >
            <Navigation size={12} className="mr-1" />
            再取得
          </Button>
        </div>
      );
    }
    if (geoState === "success" && userLocation) {
      return (
        <div className="flex items-center gap-2 py-2.5 px-4 bg-memphis-mint/15 border-2 border-memphis-mint/30 rounded-xl mb-4">
          <LocateFixed size={16} className="text-primary" />
          <span className="text-sm font-medium text-foreground/80">
            現在地付近のスポットを表示中
          </span>
          <span className="text-xs text-muted-foreground ml-auto">
            {userLocation.lat.toFixed(3)}, {userLocation.lng.toFixed(3)}
          </span>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="min-h-screen pb-20 md:pb-0">
      {/* Hero Section */}
      <section className="relative overflow-hidden py-8 sm:py-12 md:py-16">
        <MemphisBackground count={30} />
        <div className="container relative z-10">
          <div className="max-w-2xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 bg-memphis-mint/30 border-2 border-foreground rounded-full px-4 py-1.5 mb-4 shadow-[2px_2px_0px_oklch(0.15_0.01_0)]">
              <Sparkles size={14} />
              <span className="text-xs font-bold uppercase tracking-wider">学生のための割引情報</span>
            </div>
            <h1 className="text-4xl sm:text-5xl md:text-6xl font-black uppercase tracking-tight leading-[1.1] mb-4" style={{ textShadow: "3px 3px 0px oklch(0.87 0.12 165 / 0.5)" }}>
              学割マップ
            </h1>
            <p className="text-base sm:text-lg text-muted-foreground font-medium mb-6 max-w-lg mx-auto">
              近くの学割スポットを見つけて、お得に楽しもう。みんなの口コミで、もっと便利に。
            </p>

            {/* Search bar */}
            <form onSubmit={handleSearch} className="flex gap-2 max-w-md mx-auto">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="店名・エリアで検索..."
                  className="pl-10 h-12 border-2 border-foreground rounded-xl text-base shadow-[3px_3px_0px_oklch(0.15_0.01_0)]"
                />
              </div>
              <Button type="submit" className="memphis-btn h-12 px-5 rounded-xl bg-primary text-primary-foreground">
                <Search size={18} />
              </Button>
            </form>
          </div>
        </div>
      </section>

      {/* Categories */}
      <section className="py-6 sm:py-8">
        <div className="container">
          <h2 className="text-lg sm:text-xl font-extrabold uppercase tracking-tight mb-4">カテゴリ</h2>
          <div className="flex gap-2 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 sm:flex-wrap scrollbar-hide">
            {categories.length === 0
              ? Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="w-24 h-20 rounded-xl shrink-0" />
                ))
              : categories.map((cat) => (
                  <button
                    key={cat.id}
                    onClick={() => navigate(`/spots?category=${cat.id}`)}
                    className={cn(
                      "flex flex-col items-center gap-1.5 px-4 py-3 rounded-xl border-2 border-foreground shrink-0 transition-all",
                      "shadow-[2px_2px_0px_oklch(0.15_0.01_0)] hover:shadow-[3px_3px_0px_oklch(0.15_0.01_0)] hover:translate-x-[-1px] hover:translate-y-[-1px]",
                      getCategoryBgColor(cat.color)
                    )}
                  >
                    <CategoryIcon icon={cat.icon} size={22} />
                    <span className="text-xs font-bold whitespace-nowrap">{cat.name}</span>
                  </button>
                ))}
          </div>
        </div>
      </section>

      {/* Location Status + Map Section */}
      <section className="py-4 sm:py-6">
        <div className="container">
          {/* Location status banner */}
          {renderLocationBanner()}

          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg sm:text-xl font-extrabold uppercase tracking-tight">
              {userLocation ? "📍 現在地周辺のマップ" : "🗺️ マップ"}
            </h2>
            {geoState !== "loading" && !userLocation && (
              <Button
                variant="outline"
                size="sm"
                className="memphis-btn text-xs bg-memphis-mint/30"
                onClick={retryLocation}
              >
                <Navigation size={14} className="mr-1" />
                現在地を取得
              </Button>
            )}
          </div>
          <div className="rounded-xl overflow-hidden border-2 border-foreground shadow-[4px_4px_0px_oklch(0.15_0.01_0)]">
            <MapView
              className="h-[300px] sm:h-[400px]"
              initialCenter={queryCenter}
              initialZoom={userLocation ? 14 : 12}
              onMapReady={handleMapReady}
            />
          </div>

          {/* Spot count indicator */}
          {!nearbyLoading && nearbySpots.length > 0 && (
            <div className="mt-3 text-sm text-muted-foreground font-medium text-center">
              {userLocation ? (
                <>
                  現在地から <span className="text-primary font-bold">{searchRadius}km</span> 以内に{" "}
                  <span className="text-primary font-bold">{nearbySpots.length}件</span> の学割スポットが見つかりました
                </>
              ) : (
                <>
                  <span className="text-primary font-bold">{nearbySpots.length}件</span> の学割スポットを表示中
                </>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Nearby Spots */}
      <section className="py-6 sm:py-8">
        <div className="container">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg sm:text-xl font-extrabold uppercase tracking-tight">
              {userLocation ? "🎓 近くの学割スポット" : "🎓 おすすめスポット"}
            </h2>
            <Button
              variant="ghost"
              size="sm"
              className="text-primary font-bold text-sm"
              onClick={() => navigate("/spots")}
            >
              すべて見る
              <ArrowRight size={14} className="ml-1" />
            </Button>
          </div>

          {nearbyLoading || geoState === "loading" ? (
            <div className="space-y-4">
              {/* Loading state with skeleton */}
              <div className="flex items-center justify-center gap-2 py-4">
                <Loader2 size={20} className="animate-spin text-primary" />
                <span className="text-sm font-medium text-muted-foreground">
                  {geoState === "loading" ? "現在地を取得中..." : "スポットを検索中..."}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-64 rounded-xl" />
                ))}
              </div>
            </div>
          ) : nearbySpots.length === 0 ? (
            <div className="text-center py-12 bg-card rounded-xl border-2 border-foreground shadow-[4px_4px_0px_oklch(0.15_0.01_0)]">
              <MapPin size={48} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground font-medium">
                {userLocation
                  ? "近くに学割スポットが見つかりませんでした"
                  : "まだスポットが登録されていません"}
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-4">
                {userLocation && (
                  <Button
                    variant="outline"
                    className="memphis-btn bg-memphis-lilac/30"
                    onClick={() => navigate("/agent")}
                  >
                    AI検索で探す
                  </Button>
                )}
                <Button
                  className="memphis-btn bg-primary text-primary-foreground"
                  onClick={() => navigate("/submit")}
                >
                  スポットを投稿する
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {nearbySpots.slice(0, 6).map((spot) => (
                <SpotCard
                  key={spot.id}
                  spot={spot}
                  category={categoryMap.get(spot.categoryId) ?? null}
                  distance={(spot as any).distance ?? null}
                />
              ))}
            </div>
          )}

          {/* Show more button if there are more than 6 */}
          {nearbySpots.length > 6 && (
            <div className="text-center mt-6">
              <Button
                variant="outline"
                className="memphis-btn bg-memphis-yellow/20"
                onClick={() => navigate("/spots")}
              >
                さらに {nearbySpots.length - 6} 件を見る
                <ArrowRight size={14} className="ml-1" />
              </Button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
