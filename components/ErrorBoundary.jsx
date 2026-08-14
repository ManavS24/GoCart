'use client'

import { Component } from 'react'

// React surfaces render errors only to a class component; there is no hook
// equivalent. Wrap anything that can throw on a configuration this deployment
// has not made yet, so one widget cannot take the page down with it.
export default class ErrorBoundary extends Component {
    state = { failed: false }

    static getDerivedStateFromError() {
        return { failed: true }
    }

    componentDidCatch(error) {
        console.error(JSON.stringify({
            level: 'error',
            event: 'ui_error',
            boundary: this.props.name ?? 'unnamed',
            message: error?.message ?? String(error),
        }))
    }

    render() {
        return this.state.failed ? this.props.fallback ?? null : this.props.children
    }
}
