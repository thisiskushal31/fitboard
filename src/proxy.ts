import { NextResponse, type NextRequest } from "next/server";

import { decodeSession, SESSION_COOKIE, sessionTokenOptions } from "@/lib/auth/session";
import { contentSecurityPolicy, createNonce } from "@/lib/core/csp";
import { messages } from "@/lib/core/messages";
import { PRINT_TOKEN_HEADER, verifyPrintToken } from "@/lib/pdf/print-token";

/** The Claude connector's endpoint, its sign-in and the metadata that points to them. */
const CONNECTOR_PATHS = /^\/(?:api\/(?:mcp|oauth)(?:\/|$)|\.well-known\/oauth-(?:authorization-server|protected-resource)(?:\/|$))/;

/**
 * A signed-out visit goes to /login before the page is drawn, and every
 * response gets a Content-Security-Policy. The cookie check here is only a
 * first look (the cookie is present and not expired; the database is not
 * asked). Pages, layouts, actions and route handlers still check the session,
 * so a matcher mistake cannot expose data.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname === "/login") return pass(request);
  // The Claude connector uses its own OAuth token. Those routes check the
  // token, and answer 404 while the connector is off.
  if (CONNECTOR_PATHS.test(pathname)) return NextResponse.next();

  const session = await decodeSession(
    request.cookies.get(SESSION_COOKIE)?.value,
    sessionTokenOptions(),
  );
  if (session) return pass(request);

  // Server Actions answer a signed-out call with a friendly error themselves
  // (see action()); a redirect here would break their response.
  if (request.headers.has("next-action")) return pass(request);

  // The PDF renderer's headless Chromium opens print pages with a token
  // instead of a cookie; the page checks it again.
  if (
    pathname.startsWith("/print/") &&
    (await verifyPrintToken(request.headers.get(PRINT_TOKEN_HEADER), pathname))
  ) {
    return pass(request);
  }
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: messages.signedOut }, { status: 401 });
  }

  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

/**
 * Lets the request through. Pages get the policy on the response, and on the
 * request too: that's where Next.js finds the nonce for its scripts. API
 * answers (JSON, files) need none.
 */
function pass(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.next();
  // Behind a reverse proxy that ends TLS, only the forwarded header knows.
  const protocol = request.headers.get("x-forwarded-proto")?.split(",")[0].trim() ?? request.nextUrl.protocol.replace(/:$/, "");
  const policy = contentSecurityPolicy(createNonce(), { dev: process.env.NODE_ENV === "development", https: protocol === "https" });
  const headers = new Headers(request.headers);
  headers.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", policy);
  return response;
}

export const config = {
  matcher: [
    // Everything except the health check, Next.js' own assets (scripts,
    // styles, fonts, images), the dev server's hot-reload socket and public
    // files.
    "/((?!api/health(?:/|$)|_next/static/|_next/image|_next/hmr|favicon\\.ico$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt)$).*)",
  ],
};
