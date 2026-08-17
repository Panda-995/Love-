// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  app: {
    head: {
      viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
      title: 'Love小家 · CoupleSpace',
      meta: [
        { name: 'theme-color', content: '#f7edf9' },
        { name: 'mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'default' },
        { name: 'apple-mobile-web-app-title', content: 'Love小家' },
      ],
      link: [
        { rel: 'manifest', href: '/manifest.webmanifest' },
        { rel: 'icon', href: '/favicon.ico' },
        { rel: 'apple-touch-icon', href: '/desktop-icon.png' },
      ],
    },
  },
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  vite: {
    optimizeDeps: {
      include: ['@capacitor/core', '@capacitor/geolocation'],
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/three')) return 'vendor-three'
            if (id.includes('node_modules/@capacitor')) return 'vendor-capacitor'
            return undefined
          },
        },
      },
    },
  },
  runtimeConfig: {
    localDataDir: '/data',
    aiBaseUrl: 'https://api.openai.com/v1',
    aiApiKey: '',
    aiModel: '',
    amapKey: '',
    amapSecurityCode: '',
    fcmServiceAccountFile: '/data/fcm-service-account.json',
    fcmServiceAccountJson: '',
    public: {
      appVersion: '1.0.0',
      updateManifestUrl: '/app-update.json',
    },
  },
  nitro: {
    experimental: { websocket: true },
  },
  routeRules: {
    '/**': { headers: { 'cache-control': 'no-store, max-age=0' } },
  },
})
