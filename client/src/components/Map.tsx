/**
 * GOOGLE MAPS FRONTEND INTEGRATION - ESSENTIAL GUIDE
 *
 * USAGE FROM PARENT COMPONENT:
 * ======
 *
 * const mapRef = useRef<google.maps.Map | null>(null);
 *
 * <MapView
 *   initialCenter={{ lat: 40.7128, lng: -74.0060 }}
 *   initialZoom={15}
 *   onMapReady={(map) => {
 *     mapRef.current = map; // Store to control map from parent anytime, google map itself is in charge of the re-rendering, not react state.
 * </MapView>
 *
 * ======
 * Available Libraries and Core Features:
 * -------------------------------
 * 📍 MARKER (from `marker` library)
 * - Attaches to map using { map, position }
 * new google.maps.marker.AdvancedMarkerElement({
 *   map,
 *   position: { lat: 37.7749, lng: -122.4194 },
 *   title: "San Francisco",
 * });
 *
 * -------------------------------
 * 🏢 PLACES (from `places` library)
 * - Does not attach directly to map; use data with your map manually.
 * const place = new google.maps.places.Place({ id: PLACE_ID });
 * await place.fetchFields({ fields: ["displayName", "location"] });
 * map.setCenter(place.location);
 * new google.maps.marker.AdvancedMarkerElement({ map, position: place.location });
 *
 * -------------------------------
 * 🧭 GEOCODER (from `geocoding` library)
 * - Standalone service; manually apply results to map.
 * const geocoder = new google.maps.Geocoder();
 * geocoder.geocode({ address: "New York" }, (results, status) => {
 *   if (status === "OK" && results[0]) {
 *     map.setCenter(results[0].geometry.location);
 *     new google.maps.marker.AdvancedMarkerElement({
 *       map,
 *       position: results[0].geometry.location,
 *     });
 *   }
 * });
 *
 * -------------------------------
 * 📐 GEOMETRY (from `geometry` library)
 * - Pure utility functions; not attached to map.
 * const dist = google.maps.geometry.spherical.computeDistanceBetween(p1, p2);
 *
 * -------------------------------
 * 🛣️ ROUTES (from `routes` library)
 * - Combines DirectionsService (standalone) + DirectionsRenderer (map-attached)
 * const directionsService = new google.maps.DirectionsService();
 * const directionsRenderer = new google.maps.DirectionsRenderer({ map });
 * directionsService.route(
 *   { origin, destination, travelMode: "DRIVING" },
 *   (res, status) => status === "OK" && directionsRenderer.setDirections(res)
 * );
 *
 * -------------------------------
 * 🌦️ MAP LAYERS (attach directly to map)
 * - new google.maps.TrafficLayer().setMap(map);
 * - new google.maps.TransitLayer().setMap(map);
 * - new google.maps.BicyclingLayer().setMap(map);
 *
 * -------------------------------
 * ✅ SUMMARY
 * - "map-attached" → AdvancedMarkerElement, DirectionsRenderer, Layers.
 * - "standalone" → Geocoder, DirectionsService, DistanceMatrixService, ElevationService.
 * - "data-only" → Place, Geometry utilities.
 */

/// <reference types="@types/google.maps" />

import { useEffect, useRef, useState } from "react";
import { usePersistFn } from "@/hooks/usePersistFn";
import { cn } from "@/lib/utils";

declare global {
  interface Window {
    google?: typeof google;
  }
}

let mapScriptPromise: Promise<void> | null = null;
let mapScriptLoaded = false;

function loadMapScript(): Promise<void> {
  // Already loaded successfully
  if (mapScriptLoaded && window.google?.maps) {
    return Promise.resolve();
  }

  // Loading in progress
  if (mapScriptPromise) {
    return mapScriptPromise;
  }

  mapScriptPromise = new Promise<void>((resolve, reject) => {
    // Check if already loaded by another instance
    if (window.google?.maps) {
      mapScriptLoaded = true;
      resolve();
      return;
    }

    // Remove any previously failed script tags
    const existingScripts = document.querySelectorAll('script[src*="maps-js"], script[src*="maps/api/js"]');
    existingScripts.forEach(s => s.remove());

    const script = document.createElement("script");
    // Use server-side proxy to handle authentication
    // The server fetches the Maps JS API using the server-side API key
    script.src = `/api/maps-js?v=weekly&libraries=marker,places,geocoding,geometry`;
    script.async = true;

    script.onload = () => {
      // The Maps JS API bootstrap script loads additional scripts
      // Wait for google.maps to be available
      const checkReady = (attempts: number) => {
        if (window.google?.maps) {
          mapScriptLoaded = true;
          resolve();
        } else if (attempts > 50) {
          mapScriptPromise = null;
          reject(new Error("Google Maps API did not initialize after script load"));
        } else {
          setTimeout(() => checkReady(attempts + 1), 100);
        }
      };
      checkReady(0);
    };

    script.onerror = (event) => {
      mapScriptPromise = null;
      console.error("Failed to load Google Maps script from proxy");
      reject(new Error("Failed to load Google Maps script"));
    };

    document.head.appendChild(script);
  });

  return mapScriptPromise;
}

interface MapViewProps {
  className?: string;
  initialCenter?: google.maps.LatLngLiteral;
  initialZoom?: number;
  onMapReady?: (map: google.maps.Map) => void;
}

export function MapView({
  className,
  initialCenter = { lat: 35.6812, lng: 139.7671 },
  initialZoom = 12,
  onMapReady,
}: MapViewProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const init = usePersistFn(async () => {
    setLoading(true);
    setError(null);

    try {
      await loadMapScript();
    } catch (err) {
      console.warn("Map script load failed, retrying...", err);
      // Reset and retry once after a delay
      mapScriptPromise = null;
      await new Promise(r => setTimeout(r, 2000));
      try {
        await loadMapScript();
      } catch (retryErr) {
        console.error("Map script load failed after retry:", retryErr);
        setError("Google Mapsの読み込みに失敗しました。ページを再読み込みしてください。");
        setLoading(false);
        return;
      }
    }

    if (!mapContainer.current) {
      setError("マップコンテナが見つかりません");
      setLoading(false);
      return;
    }

    try {
      map.current = new window.google!.maps.Map(mapContainer.current, {
        zoom: initialZoom,
        center: initialCenter,
        mapTypeControl: true,
        fullscreenControl: true,
        zoomControl: true,
        streetViewControl: true,
        mapId: "DEMO_MAP_ID",
      });

      setLoading(false);

      if (onMapReady) {
        onMapReady(map.current);
      }
    } catch (mapErr) {
      console.error("Failed to initialize Google Map:", mapErr);
      setError("マップの初期化に失敗しました。");
      setLoading(false);
    }
  });

  useEffect(() => {
    init();
  }, [init]);

  return (
    <div className={cn("relative w-full h-[500px]", className)}>
      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted/50 rounded-xl z-10">
          <div className="flex flex-col items-center gap-2">
            <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-muted-foreground">マップを読み込み中...</span>
          </div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted/30 rounded-xl z-10">
          <div className="flex flex-col items-center gap-3 p-6 text-center">
            <div className="text-4xl">🗺️</div>
            <p className="text-sm text-muted-foreground">{error}</p>
            <button
              onClick={() => {
                mapScriptPromise = null;
                mapScriptLoaded = false;
                init();
              }}
              className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition"
            >
              再読み込み
            </button>
          </div>
        </div>
      )}
      <div ref={mapContainer} className="w-full h-full rounded-xl" />
    </div>
  );
}
