import { Component } from 'react';

// Keeps one broken component from blanking the whole app. Resets when the route changes.
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  componentDidCatch(error, info) {
    console.error('[peak] render error', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <div className="card">
          <h2>Something went wrong on this page</h2>
          <p className="muted">{this.state.error.message}</p>
          <div className="row">
            <button onClick={() => this.setState({ error: null })}>Try again</button>
            <a className="button secondary" href="/">
              Back to dashboard
            </a>
          </div>
        </div>
      </div>
    );
  }
}
