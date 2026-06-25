import Link from "next/link";

export const dynamic = "force-dynamic";

/* Main menu — just the words, in Chinese Rocks. STANLEY title + 3 destinations.
 * Headhunter is live; Missions and Kill List are inert until built. The app-wide
 * BackgroundCycler (in layout) provides the photo behind this. */

const MENU = [
  { title: "Headhunter", href: "/headhunter", active: true },
  { title: "Missions", href: null, active: false },
  { title: "Kill List", href: null, active: false },
];

export default function MainMenu() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 py-16">
      {/* Vignette for depth */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(120% 90% at 50% 34%, transparent 40%, rgba(10,6,3,0.65))" }}
      />

      <div className="relative z-10 flex w-full max-w-3xl flex-col items-center text-center">
        <h1
          className="western leading-[0.9]"
          style={{
            fontSize: "clamp(80px, 17vw, 190px)",
            color: "#f3e3c2",
            textShadow: "0 4px 0 rgba(0,0,0,0.55), 0 0 30px rgba(181,83,42,0.35)",
          }}
        >
          STANLEY
        </h1>

        <nav className="mt-10 flex flex-col items-center gap-4">
          {MENU.map((m) =>
            m.active && m.href ? (
              <Link
                key={m.title}
                href={m.href}
                className="western leading-none transition-transform hover:scale-[1.04]"
                style={{
                  fontSize: "clamp(44px, 8vw, 92px)",
                  color: "var(--gold)",
                  textShadow: "0 3px 0 rgba(0,0,0,0.5)",
                }}
              >
                {m.title}
              </Link>
            ) : (
              <span
                key={m.title}
                className="western leading-none"
                style={{
                  fontSize: "clamp(44px, 8vw, 92px)",
                  color: "rgba(172,150,118,0.45)",
                  textShadow: "0 3px 0 rgba(0,0,0,0.4)",
                }}
              >
                {m.title}
              </span>
            ),
          )}
        </nav>
      </div>
    </main>
  );
}
