'use client';

import React, { ReactNode, ReactElement } from 'react';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends React.Component<Props, State> {
  public constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error) {
    console.error('Error caught by boundary:', error);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background">
          <div className="max-w-md w-full space-y-4 text-center p-6">
            <h1 className="text-2xl font-bold text-foreground">Application Error</h1>
            <p className="text-muted-foreground">
              Something went wrong. Please refresh the page or contact support.
            </p>
            {this.state.error && (
              <details className="text-left p-4 bg-destructive/10 rounded-lg overflow-auto max-h-40">
                <summary className="cursor-pointer font-semibold text-destructive">Error Details</summary>
                <pre className="text-xs mt-2 whitespace-pre-wrap break-words">
                  {this.state.error.message}
                </pre>
              </details>
            )}
            <button
              onClick={() => window.location.reload()}
              className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition"
            >
              Refresh Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
