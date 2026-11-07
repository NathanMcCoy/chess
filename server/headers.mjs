// The headers every response carries. The tests run against this same server, so they see exactly
// what visitors get.
//   no-cache: browsers check for a newer file every time (cheap: unchanged files answer 304), so an
//     update reaches visitors at once. Cloudflare follows it (Browser Cache TTL: Respect Existing Headers).
//   no-transform: Cloudflare passes pages on unchanged, so it doesn't add its analytics script
//     (which the policy below would block).
//   Content-Security-Policy: only files from this site may run, load or be fetched. 'wasm-unsafe-eval'
//     lets Stockfish compile its WebAssembly; data: images are the piece set's built-in pictures.
export const HEADERS = {
  'Cache-Control': 'no-cache, no-transform',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
