# Love小家 coturn 镜像

这个目录只负责构建 `ghcr.io/panda-995/love-coturn`。实际部署统一使用仓库根目录的 `compose.yaml`。

- 应用首次启动时自动在 `/data/turn-secret` 创建共享密钥。
- coturn 只读挂载同一个 `./data`，启动时生成临时配置。
- 对外通话需开放 `3478/tcp`、`3478/udp` 和 `49160-49200/tcp+udp`。
- NAS 位于 NAT 后时，把公网 IP 单独写入 `./data/turn-external-ip`，并在路由器转发上述端口。
- 浏览器从应用后端获取 24 小时有效的 TURN 临时凭据，共享密钥不会进入前端。
