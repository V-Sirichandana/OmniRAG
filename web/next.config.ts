import type { NextConfig } from "next";

/**
 * Local development: `next dev` proxies /api/* to the FastAPI backend
 * running on 127.0.0.1:8000 (see README).
 *
 * On Vercel the top-level vercel.json rewrites route /api/* to the Python
 * service, so no proxy is needed there.
 */
const nextConfig: NextConfig = {
  async rewrites() {
    if (process.env.VERCEL) return [];
    const api = process.env.API_ORIGIN ?? "http://127.0.0.1:8000";
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
};

export default nextConfig;
