import React from 'react';
import { reportError } from '@/lib/error-reporting';

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('App crashed:', error, info.componentStack);
    // The component stack is the half that says *where* it broke; the browser
    // console keeps it only for whoever happened to have devtools open.
    reportError(error, {
      kind: 'react-error-boundary',
      componentStack: info.componentStack ?? undefined,
    });
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: 'red' }}>
          <h2>Something went wrong</h2>
          <p>{this.state.error.message}</p>
          <pre>{this.state.error.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
