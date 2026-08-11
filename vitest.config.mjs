import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'url'

export default defineConfig({
    // Component tests render JSX without importing React, as the app does.
    esbuild: { jsx: 'automatic' },
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./', import.meta.url)),
        },
    },
    test: {
        environment: 'node',
        include: ['tests/**/*.test.js', 'tests/**/*.test.jsx'],
    },
})
