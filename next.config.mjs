import { fileURLToPath } from "url";
import { dirname } from "path";

const here = dirname(fileURLToPath(import.meta.url));

const NODE_BUILTINS = [
  "fs",
  "fs/promises",
  "path",
  "url",
  "crypto",
  "stream",
  "os",
  "net",
  "tls",
  "http",
  "https",
  "zlib",
  "child_process",
  "worker_threads",
  "perf_hooks",
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@spr/db", "@spr/core", "@spr/trading"],
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  serverExternalPackages: ["pg", "pg-native", "ws", "bufferutil", "utf-8-validate"],
  outputFileTracingRoot: here,
  poweredByHeader: false,
  webpack: (config, { isServer, nextRuntime }) => {
    if (isServer) {
      const ext = [
        ...NODE_BUILTINS,
        ...NODE_BUILTINS.map((m) => `node:${m}`),
      ];
      const existing = Array.isArray(config.externals) ? config.externals : [];
      config.externals = [
        ...existing,
        (data, callback) => {
          const req = typeof data === "string" ? data : data.request;
          if (ext.includes(req)) {
            return callback(null, `commonjs ${req}`);
          }
          return callback();
        },
      ];
    }
    return config;
  },
};

export default nextConfig;
