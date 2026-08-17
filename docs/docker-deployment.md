# Love小家 NAS Docker 部署指南

本文面向群晖、威联通、Unraid、TrueNAS SCALE，以及其他运行 Linux Docker Engine 的 x86-64/ARM64 NAS。部署后，Web、API、SQLite、媒体、WebSocket 和 coturn 都运行在 NAS 上；只有 AI、高德地图和可选的 FCM 推送会访问外部服务。

## 1. 部署前准备

### 1.1 NAS 要求

- CPU 架构：`linux/amd64` 或 `linux/arm64`。
- 已安装 Docker Engine 和 Docker Compose 插件。可参考 [Docker 官方 Compose 安装文档](https://docs.docker.com/compose/install/linux/)。
- 建议至少预留 1 GB 内存；照片和视频所需磁盘空间取决于实际使用量。
- NAS 能访问 GHCR、高德、AI 服务；启用 FCM 时还需访问 Google/Firebase。
- 正式使用建议准备域名和 HTTPS 反向代理。

确认环境：

```bash
docker version
docker compose version
uname -m
```

`x86_64` 对应 amd64；`aarch64`、`arm64` 对应 arm64。

### 1.2 端口

| 端口 | 协议 | 用途 | 是否需要路由器转发 |
| --- | --- | --- | --- |
| `3000` | TCP | Love小家 Web/API/WebSocket | 仅局域网使用时不需要；推荐通过 HTTPS 反向代理访问 |
| `3478` | TCP + UDP | coturn 连接入口 | 只有跨公网通话时需要 |
| `49160-49200` | TCP + UDP | coturn 媒体中继 | 只有跨公网通话时需要 |

不要把 SQLite 或 `/data` 目录通过网络共享直接暴露给互联网。

## 2. 下载项目

```bash
git clone https://github.com/Panda-995/Love-.git love-home
cd love-home
cp .env.example .env
mkdir -p data
sudo chown -R 1000:1000 data
chmod 700 data
chmod 600 .env
```

容器内应用使用非 root 用户 `1000:1000`。如果出现 `EACCES`、`SQLITE_CANTOPEN` 或无法上传媒体，先重新检查 `data` 的所有者和权限。

如果希望把数据放在 NAS 的其他目录，修改 `compose.yaml` 中两个服务的卷映射。冒号左侧是 NAS 路径，右侧必须保持 `/data`：

```yaml
volumes:
  - /volume1/docker/love-home/data:/data
```

app 使用读写挂载；coturn 应继续使用 `:ro` 只读挂载。

## 3. 配置 `.env`

项目只要求维护 5 个环境变量。AI 三项未配置时只关闭 AI 生成；高德两项未配置时只关闭地图。

| 变量 | 是否必填 | 作用 | 获取方式 |
| --- | --- | --- | --- |
| `AI_API_KEY` | 使用 AI 时必填 | 在线 AI 服务的访问密钥，只在服务端使用 | 登录所选 AI 服务商的开发者控制台创建 API Key |
| `AI_BASE_URL` | 使用 AI 时必填 | OpenAI 兼容 API 的基础地址 | 查看服务商的 OpenAI 兼容接口文档；应以 `/v1` 等基础路径结束 |
| `AI_MODEL` | 使用 AI 时必填 | 请求使用的准确模型 ID | 从服务商模型列表或 `GET /v1/models` 返回值复制 |
| `AMAP_KEY` | 使用地图时必填 | 高德 Web 端（JS API）Key | 高德开放平台 → 应用管理 → 创建应用 → 添加 Web 端（JS API）Key |
| `AMAP_SECURITY_CODE` | 使用地图时必填 | 与上述 Key 配套的安全密钥 `jscode` | 创建高德 Web Key 后，在同一条 Key 记录中复制安全密钥 |

### 3.1 在线 AI API

本项目需要服务商兼容以下格式：

- `POST {AI_BASE_URL}/chat/completions`；
- `Authorization: Bearer {AI_API_KEY}`；
- 支持 `system`、`user` 消息；
- 返回 `choices[0].message.content`。

`.env` 示例：

```dotenv
AI_API_KEY=替换为服务商生成的密钥
AI_BASE_URL=https://api.example.com/v1
AI_MODEL=替换为服务商提供的模型ID
```

注意：

- `AI_BASE_URL` 必须是 HTTPS 地址。
- 只填写基础地址，不要追加 `/chat/completions`。
- 模型名必须与服务商文档完全一致，不要填写网页产品名称。
- 使用 OpenAI 时，可在 [API Keys 页面](https://platform.openai.com/api-keys)创建 Key，并通过[模型列表接口](https://platform.openai.com/docs/api-reference/models/list)确认账号可用的模型 ID；其他兼容服务请使用该服务商控制台提供的三项值。
- 不要把真实 Key 写进 `compose.yaml`、README、截图或 Git 提交。

### 3.2 高德地图

按照[高德 Maps JavaScript API 准备文档](https://lbs.amap.com/api/maps-javascript-api/prepare)创建 Web 端（JS API）Key。新 Key 需要配套安全密钥；项目会按[高德安全密钥建议](https://developer.amap.com/api/javascript-api-v2/guide/abc/jscode)在 NAS 服务端代理中使用它。

```dotenv
AMAP_KEY=替换为Web端JS_API_Key
AMAP_SECURITY_CODE=替换为安全密钥jscode
```

高德控制台中的域名白名单应填写用户实际访问 Love小家的域名。局域网 IP 测试和正式域名建议分别创建 Key，避免放宽生产 Key 的限制。

### 3.3 完整示例

```dotenv
AI_API_KEY=
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=

AMAP_KEY=
AMAP_SECURITY_CODE=
```

空值不会阻止容器启动。修改 `.env` 后需要重新创建 app 容器：

```bash
docker compose up -d --force-recreate app
```

## 4. 可选：FCM 后台推送

FCM 只负责 Android App 退到后台或被系统回收后的来电通知。未配置时，网页/App 打开期间的 WebSocket 消息和通话仍然可用。

1. 在 Firebase 控制台创建项目并启用 Firebase Cloud Messaging API (V1)。
2. 注册 Android 应用，包名必须是 `com.xiantinghua.couplespace`。
3. 按 [Firebase Android 官方步骤](https://firebase.google.com/docs/android/setup?hl=zh-CN)下载 `google-services.json`，放到 `android/app/google-services.json`，然后重新构建 APK。
4. 为 NAS 服务端下载服务账号 JSON。Firebase 的 [FCM HTTP v1 文档](https://firebase.google.com/docs/cloud-messaging/send/v1-api)说明，非 Google 服务器环境需要服务账号 JSON。
5. 将下载的文件重命名为 `fcm-service-account.json`，放到：

```text
love-home/data/fcm-service-account.json
```

6. 限制权限并重启 app：

```bash
sudo chown 1000:1000 data/fcm-service-account.json
chmod 600 data/fcm-service-account.json
docker compose restart app
```

服务账号 JSON 含私钥，不能提交到 GitHub、发送给他人或放进前端。怀疑泄露时应立即在 Google Cloud IAM 中删除旧 Key 并创建新 Key。

## 5. 可选：跨公网语音/视频通话

同一局域网通常可以直接建立 WebRTC 连接。跨网络通话需要 coturn 可从公网访问。

1. 在路由器和 NAS 防火墙转发 `3478/tcp`、`3478/udp`、`49160-49200/tcp`、`49160-49200/udp` 到 NAS。
2. NAS 位于 NAT 后时，把公网 IPv4 写入本地文件：

```bash
printf '%s\n' '203.0.113.10' > data/turn-external-ip
chmod 600 data/turn-external-ip
```

这里的 `203.0.113.10` 只是文档示例，必须替换成 NAS 所在网络的真实公网 IPv4。公网 IP 变化后需要更新文件并执行 `docker compose restart coturn`。

3. 默认情况下，客户端使用访问 Love小家的主机名连接 TURN。如果 TURN 使用另一个域名，把地址写入 `data/turn-urls`：

```bash
printf '%s\n' 'turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp' > data/turn-urls
chmod 600 data/turn-urls
docker compose restart app coturn
```

`data/turn-secret` 由 app 首次启动自动生成，禁止手动复制到 `.env` 或浏览器。coturn 使用它签发短期凭据。

内置 coturn 使用 `turn:` 的 3478/TCP 与 3478/UDP，并关闭没有证书配置的 TURN TLS/DTLS 监听。浏览器中的 WebRTC 媒体仍会进行端到端加密；如需 `turns:`，需要自行准备证书并扩展镜像配置。

## 6. 启动服务

先检查 Compose 展开结果，再拉取公开双架构镜像：

```bash
docker compose config
docker compose pull
docker compose up -d
```

`compose.yaml` 使用以下公开镜像：

```text
ghcr.io/panda-995/love-app:latest
ghcr.io/panda-995/love-coturn:latest
```

Docker 会按 NAS 架构自动选择 amd64 或 arm64 镜像。首次启动后检查：

```bash
docker compose ps
docker compose logs --tail=100 app
docker compose logs --tail=100 coturn
curl -I http://127.0.0.1:3000/
```

app 应显示 `healthy`，HTTP 应返回成功响应。打开 `http://NAS_IP:3000`，注册第一个本地账号并创建情侣空间；第二位用户注册自己的账号后使用邀请码加入。

如需修改 Web 端口，编辑 `compose.yaml`：

```yaml
ports:
  - "8080:3000"
```

只修改左侧的 NAS 端口；容器端口 `3000` 不要改。

## 7. HTTPS 反向代理

摄像头、麦克风、定位、Service Worker 和安全 Cookie 在非 localhost 环境通常需要 HTTPS。正式部署应在 NAS 自带反向代理、Caddy、Nginx Proxy Manager 或 Nginx 中配置：

- 外部域名转发到 `NAS_IP:3000`；
- 启用 WebSocket Upgrade；
- 传递 `Host`、`X-Forwarded-Host`、`X-Forwarded-Proto`；
- 不缓存 `/api/`、`/_ws`、`/media/`；
- 证书自动续期。

Nginx 核心配置示例：

```nginx
location / {
    proxy_pass http://NAS_IP:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

反向代理正常但实时消息断开时，首先检查 WebSocket Upgrade 是否被转发。

## 8. 数据目录、备份与恢复

```text
data/
├─ love.db
├─ love.db-wal / love.db-shm
├─ media/
├─ turn-secret
├─ turn-external-ip            # 可选
├─ turn-urls                   # 可选
└─ fcm-service-account.json    # 可选、敏感
```

一致性备份：

```bash
docker compose stop app coturn
cp -a data "/你的备份目录/love-home-$(date +%F)"
docker compose start app coturn
```

恢复时停止服务，用完整备份覆盖 `data`，恢复 `1000:1000` 所有权后再启动。不要只复制正在写入的 `love.db` 而遗漏 WAL 文件和媒体目录。

## 9. 升级和回滚

升级前先备份 `data`：

```bash
git pull --ff-only
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 app coturn
```

应用数据不会存放在容器层，重新创建容器不会删除 `./data`。若新版异常，可把 `compose.yaml` 中的 `latest` 临时改成发布页已有的 `sha-<提交短哈希>` 镜像标签，再执行 `docker compose pull && docker compose up -d`；数据库回滚前必须先使用对应时间点的完整数据备份。

## 10. 常见问题

### app 无法启动，日志出现权限或 SQLite 错误

```bash
sudo chown -R 1000:1000 data
chmod 700 data
docker compose restart app
```

### AI 提示“未配置”

确认 `.env` 三项都不是空值，然后执行：

```bash
docker compose config | grep NUXT_AI
docker compose up -d --force-recreate app
```

不要在公开截图中展示上述命令输出，因为它包含 API Key。

### AI 返回 401、403 或模型不存在

- 401：Key 错误、过期或环境变量没有重新加载。
- 403：账号未开通模型、余额/地域/权限受限。
- 模型不存在：`AI_MODEL` 不是接口返回的准确模型 ID。
- 404：`AI_BASE_URL` 通常错误，或误填了完整 `/chat/completions` 路径。

### 高德地图空白

- Key 必须是“Web 端（JS API）”，不能使用 Android Key 或 Web 服务 Key。
- `AMAP_SECURITY_CODE` 必须与 `AMAP_KEY` 属于同一条记录。
- 检查高德控制台的域名白名单和浏览器控制台错误。
- 修改 `.env` 后需要重新创建 app 容器。

### 实时消息不更新

检查反向代理 WebSocket Upgrade；绕过反向代理直接访问 `http://NAS_IP:3000` 做对比测试。

### 外网通话无法连接

- 确认公网 IPv4、端口转发和 NAS 防火墙。
- 检查 `data/turn-external-ip` 是否包含多余空格。
- 检查 coturn 日志：`docker compose logs --tail=200 coturn`。
- 运营商 CGNAT 没有独立公网 IPv4 时，本机 coturn 无法从公网直接访问，需要申请公网 IP 或部署可达的 TURN 主机。

### GHCR 拉取提示 denied

确认镜像包 visibility 为 public，并检查 NAS 是否能访问 `ghcr.io`。公开镜像不需要 `docker login`。

## 11. 自动双架构镜像构建

`.github/workflows/container-images.yml` 会在 `main` 分支相关文件更新、`v*` 标签或手动触发时执行：

1. 使用 QEMU + Docker Buildx；
2. 分别构建 app 和 coturn；
3. 发布 `linux/amd64`、`linux/arm64` manifest；
4. 生成 SBOM 和 provenance；
5. 推送 `latest`、分支、版本和 `sha-*` 标签到 GHCR。

可验证 manifest：

```bash
docker buildx imagetools inspect ghcr.io/panda-995/love-app:latest
docker buildx imagetools inspect ghcr.io/panda-995/love-coturn:latest
```

输出中应同时包含 `linux/amd64` 和 `linux/arm64`。首次发布后，在 GitHub 仓库右侧 Packages 中分别打开两个包，将 visibility 设为 public；之后 `compose.yaml` 可以直接匿名拉取。
