import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

type Props = { children: ReactNode };
type State = { error: Error | null };

// Catches uncaught render errors anywhere below us and shows a recoverable
// fallback instead of a blank page. We deliberately don't try to be clever
// about the cause — most fixes are "click home and try again", which the
// CTA below handles.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Logs into the user's console; surfaces nothing to the UI besides the
    // friendly fallback. If we ever wire up a real error tracker, this is
    // where it would forward.
    // eslint-disable-next-line no-console
    console.error('Uncaught render error', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="boundary">
        <div className="boundary-card">
          <h2>Something broke</h2>
          <p className="muted">
            That comparison hit a snag while rendering. The error has been
            logged to your browser console — try going home and starting over.
          </p>
          <pre className="boundary-msg">{this.state.error.message}</pre>
          <div className="boundary-actions">
            <Link className="cta primary" to="/" onClick={this.reset}>
              Back to Home
            </Link>
            <button className="cta" onClick={this.reset}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
