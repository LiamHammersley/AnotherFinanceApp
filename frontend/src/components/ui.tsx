// ponytail: minimal shadcn-style primitives on native elements — no Radix; swap in
// full shadcn/ui components if richer interactions are ever needed.
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { type ReactNode, type ComponentProps } from 'react'
import { money } from '../lib/format'

export const cn = (...args: ClassValue[]) => twMerge(clsx(args))

export function Button({ className, variant = 'default', size = 'default', ...props }: ComponentProps<'button'> & { variant?: 'default' | 'outline' | 'ghost' | 'destructive'; size?: 'default' | 'sm' }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none cursor-pointer',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-4 text-sm',
        variant === 'default' && 'bg-brand text-white hover:bg-blue-700',
        variant === 'outline' && 'border border-gray-300 bg-white hover:bg-gray-50',
        variant === 'ghost' && 'hover:bg-gray-100',
        variant === 'destructive' && 'bg-red-600 text-white hover:bg-red-700',
        className,
      )}
      {...props}
    />
  )
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn('h-9 w-full rounded-md border border-gray-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40', className)} {...props} />
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn('h-9 rounded-md border border-gray-300 bg-white px-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40', className)} {...props} />
}

// Native file inputs render their picker as unstyled text — dress it as a button
export function FileInput({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type="file"
      className={cn(
        'cursor-pointer text-sm text-gray-500',
        'file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-solid file:border-gray-300 file:bg-white file:px-2.5 file:py-1.5 file:text-xs file:font-medium file:text-gray-700 hover:file:bg-gray-50',
        className,
      )}
      {...props}
    />
  )
}

export function Card({ className, title, actions, children }: { className?: string; title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className={cn('rounded-lg border border-gray-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h3 className="text-sm font-semibold">{title}</h3>
          {actions}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  )
}

export function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-700', className)}>{children}</span>
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-lg bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 cursor-pointer">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Spinner() {
  return <div className="mx-auto my-8 h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-brand" />
}

export function Amount({ cents, className }: { cents: number | string; className?: string }) {
  const n = Number(cents)
  return <span className={cn('tabular-nums', n < 0 ? 'text-red-600' : 'text-emerald-700', className)}>{money(n)}</span>
}
