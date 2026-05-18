/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Turbopack (Next 16 default) honors the `browser` field in fflate's
  // package.json automatically, so the Node-only worker path we hit under
  // Webpack doesn't get bundled. No alias needed — Turbopack handles it.
  turbopack: {},
}

export default nextConfig
