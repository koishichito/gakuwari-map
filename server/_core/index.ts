import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);

  // Google Maps JS API proxy - serves the Maps script through the server
  // Frontend key requires Origin header, which script tags send automatically from browser
  // But in some environments the Origin may not match. This proxy uses the frontend key
  // with the correct Origin header to ensure reliable loading.
  app.get("/api/maps-js", async (req, res) => {
    try {
      const forgeApiUrl = (process.env.VITE_FRONTEND_FORGE_API_URL || process.env.BUILT_IN_FORGE_API_URL || "").replace(/\/+$/, "");
      const forgeApiKey = process.env.VITE_FRONTEND_FORGE_API_KEY || "";
      if (!forgeApiUrl || !forgeApiKey) {
        res.status(500).send("Maps proxy not configured");
        return;
      }
      const libraries = (req.query.libraries as string) || "marker,places,geocoding,geometry";
      const v = (req.query.v as string) || "weekly";
      const url = `${forgeApiUrl}/v1/maps/proxy/maps/api/js?key=${encodeURIComponent(forgeApiKey)}&v=${v}&libraries=${libraries}`;
      // Get the origin from the request or use a fallback
      const origin = req.headers.origin || req.headers.referer?.replace(/\/[^/]*$/, '') || `${req.protocol}://${req.get('host')}`;
      const response = await fetch(url, {
        headers: {
          "Origin": origin,
        },
      });
      if (!response.ok) {
        const errText = await response.text();
        console.error(`[Maps JS Proxy] Forge returned ${response.status}: ${errText}`);
        res.status(response.status).send(errText);
        return;
      }
      const jsContent = await response.text();
      res.setHeader("Content-Type", "application/javascript");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(jsContent);
    } catch (error) {
      console.error("[Maps JS Proxy] Error:", error);
      res.status(500).send("Failed to load Maps script");
    }
  });
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
