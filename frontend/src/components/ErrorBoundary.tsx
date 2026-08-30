// Without this, a single bad render unmounts the whole app and you get a white
// page with no clue what happened. The nav stays usable, the error is legible,
// and reloading is one click rather than a guess.
import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null; stack: string }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep it in the console too — the component stack is what pinpoints the row
    console.error('Render failed:', error, info.componentStack)
    this.setState({ stack: info.componentStack || '' })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="mx-auto max-w-2xl rounded-xl border border-[#f5c9a8] bg-[#fdf2e9] p-5">
        <h2 className="text-[15px] font-[650] text-[#a8500f]">This page hit an error</h2>
        <p className="mt-1 text-[13px] text-[#a8500f]">
          The rest of the app still works — use the menu above, or reload to try again.
        </p>
        <p className="mt-3 rounded-md border border-[#f0d3bb] bg-white/60 p-2 font-mono text-[12px] text-[#8a4a12]">
          {this.state.error.message || String(this.state.error)}
        </p>
        <div className="mt-3 flex gap-2">
          <button onClick={() => this.setState({ error: null, stack: '' })}
            className="h-8 cursor-pointer rounded-lg border border-[#e5b48c] px-3 text-[12.5px] text-[#a8500f] hover:bg-white/60">
            Try again
          </button>
          <button onClick={() => window.location.reload()}
            className="h-8 cursor-pointer rounded-lg bg-[#a8500f] px-3 text-[12.5px] text-white hover:bg-[#8a4a12]">
            Reload
          </button>
        </div>
        {this.state.stack && (
          <details className="mt-3">
            <summary className="cursor-pointer text-[12px] text-[#a8500f]">Where it happened</summary>
            <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] text-[#8a4a12]">{this.state.stack}</pre>
          </details>
        )}
      </div>
    )
  }
}
