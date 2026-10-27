import { FIGMA_PROVIDER } from "./providers/figma.js";

/** One policy for the CLI, development server and generated Caddy header. */
export const WEB_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://avatars.githubusercontent.com",
  "font-src 'self'",
  `connect-src 'self' ${FIGMA_PROVIDER.connectOrigins.join(" ")}`,
  `frame-src ${FIGMA_PROVIDER.frameOrigins.join(" ")}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
