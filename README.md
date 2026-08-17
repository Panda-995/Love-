# Love小家（NAS 本地版）

Love小家是一个情侣私密空间，包含本地账号、共同回忆、相册、悄悄话、情书、纪念日、共同清单、情侣宠物、AI 写作、位置地图、语音/视频通话和 Android 推送。

这个分支以 NAS 为中心运行：Web、API、SQLite、媒体、WebSocket 和 coturn 全部放在本地。运行时不需要 Supabase、Cloudflare、Google 登录、GitHub 登录或第三方通话服务，也不会连接外部服务生成网站。

## 架构与功能影响

| 能力 | 实现 | 是否需要外部服务 | 未配置时的影响 |
| --- | --- | --- | --- |
| Web 与 API | 单个 Nuxt/Nitro 容器 | 否 | — |
| 登录与会话 | 本地账号、加盐 scrypt 密码、HttpOnly Cookie | 否 | — |
| 数据 | `/data/love.db`（SQLite WAL） | 否 | — |
| 照片、视频、语音 | `/data/media` 私有目录 | 否 | — |
| 实时消息与状态 | 同源 WebSocket | 否 | — |
| 语音/视频通话 | WebRTC + 本地 coturn | 否 | 外网通话需要公网端口或可达的 TURN 地址 |
| 心动 AI | 在线 OpenAI 兼容 API | 是，仅生成时 | 未配置时仅 AI 生成不可用，已保存内容不受影响 |
| 地图与定位 | 高德 JS API + NAS 端安全代理 | 是，高德 | 仅地图选择/展示不可用 |
| Android 后台推送 | FCM HTTP v1 | 是，FCM | App 关闭后的来电推送不可用；站内实时消息仍可用 |

核心业务功能保持不变，但有三个明确边界：原云数据库中的历史数据不会自动迁移；WebRTC、定位和摄像头在普通浏览器中建议通过 HTTPS 使用；NAS 不可达时，双方设备不能同步本地数据。

## 快速部署

要求：支持 Docker Compose 的 x86-64 或 ARM64 NAS。环境变量获取、NAS 目录映射、FCM、coturn、HTTPS、升级备份与排障请查看 **[完整 Docker 部署指南](docs/docker-deployment.md)**。

```bash
git clone https://github.com/panda-995/Love-.git love-home
cd love-home
cp .env.example .env
mkdir -p data
sudo chown -R 1000:1000 data
docker compose pull
docker compose up -d app coturn
```

启动前至少应打开 `.env`，按需填写 AI 和高德配置；所有变量的含义与获取入口均在完整部署指南中逐项说明。

打开 `http://NAS_IP:3000`，注册第一个本地账号并创建情侣空间；另一位用户注册自己的账号后，用邀请码加入即可。数据库表、TURN 密钥和媒体目录会在首次启动时自动创建，不需要手动执行 SQL。

应用容器以非 root 的 UID/GID `1000:1000` 运行；如果 NAS 上的 `./data` 权限不同，请把该目录所有者调整为 `1000:1000`。查看状态：

```bash
docker compose ps
docker compose logs -f app coturn
```

## 在线通用 AI API

AI 仅通过服务端访问实现 OpenAI `POST /v1/chat/completions` 的在线服务。在 `.env` 配置：

```dotenv
AI_BASE_URL=https://你的接口地址/v1
AI_API_KEY=你的密钥
AI_MODEL=模型名
```

`AI_BASE_URL` 必须是 HTTPS 基础地址，不要填写完整的 `/chat/completions` 路径。修改后执行 `docker compose up -d app`。API Key 只保存在 NAS 服务端环境变量中，不会发到浏览器。未配置 AI 时，其余功能不受影响。

`.env.example` 只保留以上三项 AI 配置和两项高德配置；端口、容器用户、版本号、FCM 路径与 TURN 常规配置均使用内置默认值或 `./data` 下的文件。

## 高德地图

在高德开放平台创建 Web 端 JS API Key，并把 Key 与安全密钥写入 `.env`：

```dotenv
AMAP_KEY=你的_Web_JS_API_Key
AMAP_SECURITY_CODE=你的安全密钥_jscode
```

前端只收到 JS API Key；安全密钥由 `/_AMapService` 同源代理在服务端附加。部署 HTTPS 后，应在高德控制台填写实际域名白名单。

## FCM 后台推送

FCM 仅用于 Android App 在后台或被系统回收后的来电提醒，不参与账号登录和日常数据同步。

1. 从 Firebase 项目下载服务账号 JSON，保存为 `./data/fcm-service-account.json`。
2. 将 Android 客户端的 `google-services.json` 保存到 `android/app/google-services.json`。
3. 重新构建 Android App，并让两位用户在系统设置中允许通知。

服务账号文件和客户端配置都已加入 `.gitignore`，不要提交到仓库。未配置 FCM 时，打开网页/App 后的 WebSocket 实时提醒仍然工作。

## coturn 与外网通话

同一局域网中的通话通常不需要公网配置。跨网络通话时：

1. 在路由器和 NAS 防火墙开放并转发 `3478/tcp`、`3478/udp`、`49160-49200/tcp` 和 `49160-49200/udp`。
2. NAS 位于 NAT 后时，将公网 IPv4 写入本地文件：

```bash
printf '%s\n' '你的公网IPv4' > data/turn-external-ip
```

3. 默认使用浏览器访问 Love小家的主机名作为 TURN 地址。如果 TURN 使用不同域名，将逗号分隔的地址写入 `data/turn-urls`，例如 `turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp`。

长期共享密钥由应用自动生成在 `./data/turn-secret`。浏览器登录后只会得到短期 HMAC 凭据。

## HTTPS 与反向代理

本地账号和相册在 HTTP 下可以使用，但摄像头、麦克风、定位、Service Worker 等浏览器能力在非 localhost 环境通常要求安全上下文。正式部署建议使用 NAS 自带反向代理、Caddy、Nginx Proxy Manager 等提供 HTTPS，并确保代理：

- 转发普通 HTTP 请求到 `app:3000`；
- 支持 WebSocket Upgrade；
- 传递 `Host`、`X-Forwarded-Host` 和 `X-Forwarded-Proto`；
- 不缓存 `/api/`、`/_ws` 和 `/media/` 的私有响应。

## Android 与桌面客户端

Android 包需要在同步时指定 NAS 的可访问 HTTPS 地址，否则 APK 内没有本地 API：

```bash
LOVE_HOME_URL=https://love.example.com npm run android:sync
cd android
./gradlew assembleDebug
```

Windows Electron 客户端通过环境变量连接 NAS：

```powershell
$env:LOVE_HOME_URL='https://love.example.com'
npm run desktop:dev
```

## 数据目录与备份

所有必须备份的运行数据都在一个目录中：

```text
data/
├─ love.db
├─ love.db-wal / love.db-shm   # 运行期间可能存在
├─ media/                      # 私有照片、视频、语音和头像
├─ turn-secret                 # coturn 共享密钥
├─ turn-external-ip            # NAT 后可选
├─ turn-urls                   # TURN 使用独立域名时可选
└─ fcm-service-account.json    # 可选
```

一致性备份建议先短暂停止写入，再复制整个目录：

```bash
docker compose stop app coturn
cp -a data "/你的备份目录/love-home-$(date +%F)"
docker compose start app coturn
```

恢复时停止服务，用备份覆盖 `data` 并保持原来的文件所有者，然后重新启动。不要只复制正在写入的 `love.db` 而忽略 WAL 文件。

## 双架构镜像与自动构建

公开镜像：

- `ghcr.io/panda-995/love-app:latest`
- `ghcr.io/panda-995/love-coturn:latest`

GitHub Actions 会在 `main` 分支和版本标签上通过 Buildx 构建并发布 `linux/amd64`、`linux/arm64` manifest；Pull Request 只构建验证，不推送。`compose.yaml` 已直接使用上述镜像。

GHCR 包如果首次显示为 private，需要在仓库 Packages 页面把两个包的 visibility 设为 public；此操作只需做一次。

## 本地开发与验证

需要 Node.js 24：

```bash
npm ci
npm run typecheck
npm test
npm run build
```

服务端使用 Node 内置 `node:sqlite`，因此不要用旧版 Node 启动生产服务。

## 安全说明

- 本地密码使用随机盐和 scrypt 派生值保存，不存明文。
- 登录会话使用 HttpOnly、SameSite Cookie；HTTPS 下自动设置 Secure。
- 所有数据、媒体和 WebSocket 事件按情侣空间隔离；媒体路径、类型和大小由服务端验证。
- AMap 安全密钥、AI Key、FCM 私钥和 TURN 共享密钥都不会进入前端包。
- 请为 NAS 开启 HTTPS、定期备份 `data`，并只开放确实需要的端口。

本项目基于 [XTH-LOVE/Love-](https://github.com/XTH-LOVE/Love-) 改造，保留原项目许可与署名。
