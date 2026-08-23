import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The model this App runs under, and the one the SSE route has to survive: with Cache
   * Components on, a `GET` handler is executed at build time and only stops being prerendered
   * once it reads request data. The library's handler does that as its first act.
   */
  cacheComponents: true,
};

export default nextConfig;
