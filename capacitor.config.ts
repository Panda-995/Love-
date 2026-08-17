import type { CapacitorConfig } from '@capacitor/cli'

const homeUrl = String(process.env.LOVE_HOME_URL || '').trim().replace(/\/$/, '')

const config: CapacitorConfig = {
  appId: 'com.xiantinghua.couplespace',
  appName: 'Love小家',
  webDir: '.output/public',
  backgroundColor: '#f7edf9',
  server: homeUrl ? { url: homeUrl, cleartext: homeUrl.startsWith('http://') } : undefined,
  android: { backgroundColor: '#f7edf9', allowMixedContent: false },
  plugins: {
    StatusBar: { style: 'LIGHT', backgroundColor: '#f7edf9', overlaysWebView: false },
    SplashScreen: { launchShowDuration: 2200, launchAutoHide: true, backgroundColor: '#f7edf9', androidScaleType: 'CENTER_INSIDE', showSpinner: false },
  },
}

export default config
