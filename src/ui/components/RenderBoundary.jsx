import { Component } from 'react';

// The engine and its webviews outlive React. Retrying the interface must not
// reload the page or start a second copy of the downloads.
export default class RenderBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) { return { error }; }

  componentDidCatch(error, info) {
    console.error('[ui] rendering failed:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty" role="alert" style={{ height: '100%' }}>
        <h3>The interface ran into a problem</h3>
        <p>Your download queue is still available. Restore the interface to continue.</p>
        <p className="hint">{String(this.state.error.message || this.state.error)}</p>
        <button className="btn" onClick={() => this.setState({ error: null })}>Restore interface</button>
      </div>
    );
  }
}
