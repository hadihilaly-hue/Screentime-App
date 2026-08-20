import type { ReactNode } from 'react'

/**
 * Shared presentation for the phone-sized shell every screen lives in. No
 * behaviour here — routing and data stay in App and the pages.
 */
export function Screen({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow?: string
  title?: string
  subtitle?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="fade-up flex flex-col">
      {(eyebrow || title) && (
        <header className="mb-6">
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          {title && (
            <h1 className="mt-2 text-[1.75rem] leading-tight font-extrabold tracking-[-0.03em]">
              {title}
            </h1>
          )}
          {subtitle && <p className="mt-2 text-[0.9375rem] leading-snug text-muted">{subtitle}</p>}
        </header>
      )}
      {children}
    </section>
  )
}

/** Full-height centred state for loading and hard errors. */
export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center gap-4 text-center">
      {children}
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <Centered>
      <span className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-acid" />
      {label && <p className="text-sm text-faint">{label}</p>}
    </Centered>
  )
}

/** The three screens that are still spec placeholders share one look. */
export function ComingSoon({
  eyebrow,
  title,
  blurb,
  section,
  icon,
}: {
  eyebrow: string
  title: string
  blurb: string
  section: string
  icon: ReactNode
}) {
  return (
    <Screen eyebrow={eyebrow} title={title}>
      <div className="card flex flex-col items-center gap-4 px-6 py-12 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-panel-hi text-muted">
          {icon}
        </span>
        <p className="max-w-[22ch] text-[0.9375rem] leading-snug text-muted">{blurb}</p>
        <span className="tag">Not built yet · {section}</span>
      </div>
    </Screen>
  )
}

/* --- icons ---------------------------------------------------------------
   Inline so the app ships no icon dependency. All 24x24, currentColor. */

type IconProps = { className?: string }

const base = 'h-5 w-5'

export function IconCheck({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M5 13l4.2 4.2L19 7.5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function IconPlus({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}

export function IconTrash({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M4 7h16M10 7V5h4v2M6.5 7l.8 12.1a1 1 0 001 .9h7.4a1 1 0 001-.9L17.5 7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function IconClose({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function IconBack({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M14.5 5.5L8 12l6.5 6.5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function IconCamera({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M3 8.5A2.5 2.5 0 015.5 6h1.7l1.1-2h7.4l1.1 2h1.7A2.5 2.5 0 0121 8.5v8A2.5 2.5 0 0118.5 19h-13A2.5 2.5 0 013 16.5v-8z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12.5" r="3.4" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

export function IconShield({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M12 3l7 2.8v5.4c0 4.3-2.9 7.7-7 9.8-4.1-2.1-7-5.5-7-9.8V5.8L12 3z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M8.8 12.2l2.2 2.2 4.2-4.4"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function IconChart({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M5 19V10M12 19V5M19 19v-6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function IconBolt({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M13.5 3L5.5 13.5h5L10 21l8.5-10.5h-5.2L13.5 3z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  )
}
