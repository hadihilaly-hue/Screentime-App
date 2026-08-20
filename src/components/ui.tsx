import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { TaskStatus, Tier } from '../lib/types'

export function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full bg-gray-900 text-gray-100">
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-4 safe-top safe-bottom">
        {children}
      </div>
    </div>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
}

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  const styles = {
    primary: 'bg-emerald-500 text-gray-900 hover:bg-emerald-400 disabled:bg-gray-700 disabled:text-gray-500',
    secondary: 'bg-gray-700 text-gray-100 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600',
    danger: 'bg-red-600 text-white hover:bg-red-500 disabled:bg-gray-800 disabled:text-gray-600',
    ghost: 'bg-transparent text-gray-400 hover:text-gray-200 disabled:text-gray-700',
  }[variant]
  return (
    <button
      {...props}
      className={`rounded-lg px-4 py-3 text-base font-semibold transition-colors disabled:cursor-not-allowed ${styles} ${className}`}
    />
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-gray-700 bg-gray-800 p-4 ${className}`}>{children}</div>
}

export function TierBadge({ tier, overridden }: { tier: Tier; overridden?: boolean }) {
  const colors = {
    1: 'bg-purple-900 text-purple-200',
    2: 'bg-blue-900 text-blue-200',
    3: 'bg-gray-700 text-gray-300',
  }[tier]
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-bold ${colors}`}>
      T{tier}
      {overridden ? ' •' : ''}
    </span>
  )
}

export function StatusChip({ status }: { status: TaskStatus }) {
  const map: Record<TaskStatus, [string, string]> = {
    todo: ['todo', 'bg-gray-700 text-gray-300'],
    pending: ['pending proof', 'bg-amber-900 text-amber-200'],
    verified: ['verified', 'bg-emerald-900 text-emerald-200'],
    rejected: ['rejected', 'bg-red-900 text-red-200'],
  }
  const [label, styles] = map[status]
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${styles}`}>{label}</span>
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null
  return (
    <p className="rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-200">{children}</p>
  )
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex flex-1 items-center justify-center py-16 text-gray-500">
      <span className="animate-pulse">{label}</span>
    </div>
  )
}
