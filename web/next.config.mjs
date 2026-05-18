/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Pin Next's workspace root to this folder (a leftover pnpm-workspace.yaml
  // exists in a parent directory which would otherwise be picked up).
  outputFileTracingRoot: import.meta.dirname,
  // Empty turbopack config is enough to silence the Next 16 warning;
  // we run with --webpack so the webpack hook below is what's actually used.
  turbopack: {},
  webpack: (config, { isServer }) => {
    // jspdf bundles fflate, whose Node entry uses a dynamic `new Worker(...)`
    // that Webpack can't statically resolve. We only use jspdf in the browser
    // (lazy-imported inside a click handler), so stub the Node bits on the
    // client and skip them entirely on the server.
    if (!isServer) {
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        worker_threads: false,
        fs: false,
        path: false,
      }
    }
    return config
  },
}

export default nextConfig
