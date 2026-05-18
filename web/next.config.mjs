/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Next.js SSRs client components at build time. That picks the `node`
  // condition in jspdf's and fflate's exports maps, which resolves to their
  // Node-only entries — fflate's contains `new Worker(c + workerAdd)` and is
  // statically unresolvable. We use jspdf only in the browser (lazy-loaded
  // inside a click handler), so force both packages to their browser-safe
  // ESM entries on every import path.
  turbopack: {
    resolveAlias: {
      jspdf: 'jspdf/dist/jspdf.es.min.js',
      fflate: 'fflate/browser',
    },
  },
}

export default nextConfig
