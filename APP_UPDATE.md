# Love小家更新方式

## 网页和电脑软件

网页部署到 `https://love-home.pages.dev/` 后，电脑端下次打开会直接加载最新网页。网页界面和业务逻辑更新不需要重新制作 EXE。

## Android APK

1. 同步修改 `package.json`、`package-lock.json`、`nuxt.config.ts` 和 `app/composables/useAppUpdate.ts` 中的语义化版本号。
2. 修改 `android/app/build.gradle`：每次发布都必须递增 `versionCode`，并将 `versionName` 设为相同版本号。
3. 更新 `public/sw.js` 的缓存版本，确保 PWA 客户端淘汰旧静态资源。
4. 修改 `public/app-update.json` 的 `version`、`title`、`notes` 和 `publishedAt`，保持下载地址不变。
5. 构建最新版 APK：`npm run android:apk`。
6. 将 APK 上传到部署站点的 `/downloads/Love小家-latest.apk`。
7. 用户打开 App 后会看到更新提示，点击后下载最新版 APK 并由 Android 完成安装确认。

Android 出于系统安全限制，首次安装未知来源应用时，用户仍需要允许浏览器或文件管理器安装应用；应用不能在后台静默替换自身。
