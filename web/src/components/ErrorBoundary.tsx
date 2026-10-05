import { Component, type ReactNode } from 'react'

interface Props {
  /** Changing this clears a caught error, e.g. when the user opens a different asset. */
  resetKey: string
  fallback: (error: Error) => ReactNode
  children: ReactNode
}

interface State {
  error: Error | null
  resetKey: string
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey }
  }

  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children
  }
}
