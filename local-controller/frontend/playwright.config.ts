import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 240_000,
  use: {
    baseURL: process.env.FRONTEND_URL || 'http://localhost:5174',
    viewport: { width: 1920, height: 1080 },
    screenshot: 'on',
  },
  webServer: {
    command: 'npx vite --port 5174 --host 0.0.0.0',
    port: 5174,
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
