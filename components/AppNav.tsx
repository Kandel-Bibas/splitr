import { useLayoutEffect, useRef } from "react";
import Link from "@/components/Link";
import { useRouterState } from "@tanstack/react-router";
import { signOut, useSession } from "../src/auth";

// Each section also owns the detail pages under these prefixes
const NAV_LINKS = [
  { label: "Money", href: "/", owns: ["/transactions/"] },
  { label: "Splits", href: "/splits", owns: ["/expenses/"] },
  { label: "People", href: "/people", owns: [] },
  { label: "Tags", href: "/tags", owns: [] },
  { label: "Banks", href: "/accounts", owns: [] },
] as const;

function isActive(pathname: string, { href, owns }: (typeof NAV_LINKS)[number]): boolean {
  return (
    pathname === href ||
    (href !== "/" && pathname.startsWith(href + "/")) ||
    owns.some((prefix) => pathname.startsWith(prefix))
  );
}

/**
 * Adding or editing something, where the screen's own Save bar sits at the
 * bottom. Phones hide the tab bar here, like an app's create screens.
 */
function isFormScreen(pathname: string): boolean {
  return pathname.startsWith("/expenses/new") || pathname.startsWith("/transactions/new");
}

function usePathname(): string {
  return useRouterState({ select: (s) => s.location.pathname });
}

/**
 * The yellow "you are here" pill: one shape behind the links that glides to
 * the active one. Placed straight away on first paint and whenever the links
 * change size (the font loading, the phone rotating); only a change of
 * section animates.
 */
function useSlidingPill(activeIndex: number) {
  const listRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const activeRef = useRef(activeIndex);
  const placedOnce = useRef(false);

  function place(animate: boolean) {
    const list = listRef.current;
    const pill = pillRef.current;
    if (!list || !pill) return;
    const link = list.querySelectorAll<HTMLElement>("a")[activeRef.current];
    if (!link || link.offsetWidth === 0) {
      pill.style.opacity = "0";
      return;
    }
    // With no transition, the pill jumps; reading offsetWidth applies that
    // before the transition comes back for the next move
    if (!animate) pill.style.transition = "none";
    pill.style.opacity = "1";
    pill.style.width = `${link.offsetWidth}px`;
    pill.style.height = `${link.offsetHeight}px`;
    pill.style.transform = `translate(${link.offsetLeft}px, ${link.offsetTop}px)`;
    if (!animate) {
      void pill.offsetWidth;
      pill.style.transition = "";
    }
  }

  // A change of section glides the pill (after its first placement)
  useLayoutEffect(() => {
    activeRef.current = activeIndex;
    place(placedOnce.current);
    placedOnce.current = true;
  });

  // A change of size re-places it without animating. Set up once: a new
  // observer reports straight away, which would cut a glide short.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const resized = new ResizeObserver(() => place(false));
    resized.observe(list);
    return () => resized.disconnect();
  }, []);

  return { listRef, pillRef };
}

const PILL =
  "absolute top-0 left-0 rounded-full border border-ink bg-sun pointer-events-none transition-[transform,width,opacity] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none";

/** The top bar. Sections show here from tablet width up; phones get BottomTabs. */
export default function AppNav() {
  const pathname = usePathname();
  const { listRef, pillRef } = useSlidingPill(NAV_LINKS.findIndex((link) => isActive(pathname, link)));
  const email = useSession().user.email;

  return (
    // On short screens (a phone on its side) it scrolls away instead of
    // staying pinned, leaving room for the page and its Save bar
    <header className="sticky [@media(max-height:500px)]:static top-0 z-40 bg-surface/90 backdrop-blur border-b border-ink pt-[env(safe-area-inset-top)]">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 h-16 flex items-center gap-2 sm:gap-6">
        {/* Wordmark */}
        <Link
          href="/"
          className="tap-area font-display text-[28px] uppercase text-ink shrink-0"
          aria-label="Splitr home"
        >
          Splitr
        </Link>

        {/* Sections */}
        <nav className="hidden sm:flex flex-1 min-w-0" aria-label="Main navigation">
          <div ref={listRef} className="relative flex items-center gap-1">
            <span ref={pillRef} aria-hidden="true" className={PILL} />
            {NAV_LINKS.map((link) => {
              const active = isActive(pathname, link);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={[
                    "relative px-3 h-8 inline-flex items-center rounded-full text-sm font-semibold transition-colors whitespace-nowrap border border-transparent",
                    active ? "text-ink" : "text-ink-muted hover:text-ink hover:bg-mist",
                  ].join(" ")}
                  aria-current={active ? "page" : undefined}
                >
                  {link.label}
                </Link>
              );
            })}
          </div>
        </nav>

        {/* Primary action */}
        <Link
          href="/expenses/new"
          aria-label="New expense"
          className="ml-auto sm:ml-0 shrink-0 inline-flex items-center justify-center gap-1 h-9 px-4 rounded-full bg-ink text-white text-sm font-semibold hover:bg-accent-hover transition-colors"
        >
          <span aria-hidden="true" className="text-base leading-none">+</span>
          <span>New</span>
        </Link>

        {/* Account */}
        <div className="shrink-0 flex items-center gap-2">
          {email && (
            <span className="hidden md:inline max-w-[14rem] truncate text-sm text-ink-muted" title={email}>
              {email}
            </span>
          )}
          <button
            type="button"
            onClick={() => void signOut()}
            title={email ? `Signed in as ${email}` : undefined}
            className="h-9 px-3 rounded-full text-sm font-semibold text-ink-muted hover:text-ink hover:bg-mist transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

/** The sections along the bottom of a phone screen, within thumb reach. */
export function BottomTabs() {
  const pathname = usePathname();
  const { listRef, pillRef } = useSlidingPill(NAV_LINKS.findIndex((link) => isActive(pathname, link)));

  // Hidden rather than removed on form screens, so the pill stays placed
  return (
    <nav
      hidden={isFormScreen(pathname)}
      className="sm:hidden fixed inset-x-0 bottom-0 z-40 bg-surface/95 backdrop-blur border-t border-ink h-[var(--tabbar)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
      aria-label="Main navigation"
    >
      <div className="h-full px-2 flex items-center">
        <div ref={listRef} className="relative w-full grid grid-cols-5 items-center gap-1">
          <span ref={pillRef} aria-hidden="true" className={PILL} />
          {NAV_LINKS.map((link) => {
            const active = isActive(pathname, link);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={[
                  "relative h-11 inline-flex items-center justify-center rounded-full text-sm font-semibold transition-[color,transform] border border-transparent active:scale-95",
                  active ? "text-ink" : "text-ink-muted",
                ].join(" ")}
                aria-current={active ? "page" : undefined}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
