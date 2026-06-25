import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Single-user auth gate. OFF unless APP_PASSWORD is set (so local dev stays
 * open); ON automatically on Vercel once APP_PASSWORD + APP_SESSION_TOKEN are
 * configured. Exempts the login flow and the machine endpoints that carry their
 * own secret (cron, webhooks).
 */
export function middleware(req: NextRequest) {
  if (!process.env.APP_PASSWORD) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/login") ||
    pathname.startsWith("/api/cron") ||
    pathname.startsWith("/api/webhooks")
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get("jarvis_auth")?.value;
  if (token && token === process.env.APP_SESSION_TOKEN) return NextResponse.next();

  if (pathname.startsWith("/api/")) return new NextResponse("unauthorized", { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
