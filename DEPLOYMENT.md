# Docker + Nginx 自托管

当前生产部署使用 Node.js 24 + SQLite，所有房间、走棋与日志均保存在自己的服务器。无需 Cloudflare 账号或云数据库。一次只运行一个应用实例；多实例不能共享同一个 SQLite 文件来实现跨进程实时对局。

## 从源码启动

在安装了 Docker Engine 和 Compose 的 Linux 服务器上，进入项目根目录：

```bash
cp .env.example .env
mkdir -p secrets
chmod 700 secrets
# 用本地编辑器填写 16–256 字符的管理员密码，不要提交这个文件。
editor secrets/admin-password.txt
# 容器使用 node 用户（UID/GID 1000），让它能读取挂载的秘密文件。
sudo chown 1000:1000 secrets/admin-password.txt
sudo chmod 600 secrets/admin-password.txt
```

编辑 `.env`：将 `PUBLIC_ORIGIN` 改为实际的 HTTPS 地址，例如 `https://chess.your-domain.com`；设置 `ADMIN_USERNAME`。管理员从 `/admin` 使用这组账号、密码登录。

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
docker compose logs --tail=50
```

SQLite 使用命名卷 `hidden-crown-data`，容器重建、升级不会丢掉对局。容器端口默认只发布到宿主机 `127.0.0.1:8787`。应用按 `PUBLIC_ORIGIN` 校验 Host 和 Origin；直接从内网访问时也需要正确的 Host。

## Nginx

把 `deploy/nginx.conf` 放入 Nginx 的 `http {}` 配置范围（例如 `conf.d/hidden-crown.conf`），把 `deploy/hidden-crown-proxy.conf` 放到 `/etc/nginx/snippets/hidden-crown-proxy.conf`。替换示例域名和证书路径，后端端口与 `.env` 的 `HOST_PORT` 保持一致。保留 WebSocket 的 Upgrade/Connection 头和超时设置。

```bash
sudo nginx -t
sudo systemctl reload nginx
```

反代配置会覆盖客户端传来的 `X-Forwarded-For`。`.env` 的 `TRUSTED_PROXIES` 只填写应用容器实际看到的 Nginx 来源 IP（精确地址，逗号分隔；不支持 CIDR）。宿主机 Nginx 连接 Docker 发布端口时，这通常是该 Compose 网络的网关；可通过 `docker network inspect <项目名>_default` 核对。默认留空会忽略转发头，安全但会把同一代理后的用户合并计入同一个 IP 限额。不要信任任意地址或使用 `$proxy_add_x_forwarded_for` 来保留不可信前缀。

Nginx 在容器内时，需要让它和应用在同一个受控 Docker 网络中，并将反代 upstream 改为 `http://hidden-crown:8787`。同时填写它的确切容器 IP；不要把后端端口直接暴露到公网。

## 发布镜像与简单拉取

流程参照 KazuhaHub/Passwall-Sub-Panel：版本标签 `v1.0.0` 触发 Release，先在原生 AMD64、ARM64 runner 上运行验证和容器启动检查，再发布对应架构镜像并组合 manifest。GHCR 标签为 `1.0.0`、稳定版 `latest`、最近发布版 `beta`。手动运行 Release 时也必须选择已有版本标签。发布需递增版本号；精确版本不重复覆盖。

仓库为个人账号下的私有仓库 `KKazuhaK/hidden-crown`。GHCR 镜像保持私有；先在服务器使用有此仓库访问权且具有 `read:packages` 权限的个人访问令牌登录，再拉取镜像。不要把令牌写进 Compose、`.env` 或命令行参数。

```bash
read -s -p "GHCR token: " HC_GHCR_TOKEN; echo
printf '%s' "$HC_GHCR_TOKEN" | docker login ghcr.io -u KKazuhaK --password-stdin
unset HC_GHCR_TOKEN
```

Release 中提供 Compose、`.env.example` 和 Nginx 配置，登录 GitHub 后下载。镜像需等待首次版本发布成功后才能拉取；若使用其他仓库名，替换 `.env` 的 `HIDDEN_CROWN_IMAGE`。

完成上面的账号、密码及 Nginx 配置后：

```bash
docker compose pull
docker compose up -d
```

使用源码覆盖文件部署的用户仍使用 `-f docker-compose.yml -f docker-compose.build.yml`。固定镜像版本可将 `HIDDEN_CROWN_IMAGE` 设为 `ghcr.io/kkazuhak/hidden-crown:1.0.0`。升级前请备份数据卷；需要回滚时改回之前的版本并重新启动。

## 默认防护与可调限额

| 范围 | 默认值 | 配置 |
| --- | --- | --- |
| 单 IP 创建房间 | 10 分钟容量 5，持续补充 | `CREATE_LIMIT_PER_IP` |
| 全站创建房间 | 10 分钟容量 50，持续补充 | `CREATE_LIMIT_GLOBAL` |
| 保存房间总数，包含已结束对局 | 1000 | `MAX_ROOMS` |
| WebSocket 连接总数 | 512 | `MAX_CONNECTIONS` |
| SQLite 主库页空间上限 | 256 MiB，另需 WAL/日志余量 | `MAX_DATABASE_BYTES` |
| 单房间状态和日志 | 4 MiB | `MAX_ROOM_BYTES` |
| HTTP 单 IP / 全站 | 120 / 2000 次每分钟容量 | 固定 |
| 登录单 IP / 全站 | 5 / 30 次每 15 分钟容量 | 固定 |
| WebSocket 握手单 IP | 30 次每分钟容量 | 固定 |
| 单 WebSocket 消息 | 每秒容量 30 | 固定 |
| 房间连接 / 未认证连接 | 16 / 8 | 固定 |
| 未认证连接期限 | 15 秒 | 固定 |

限额按有界 token bucket 实现。伪造转发头不会绕过默认 IP 限额。未知房间请求不创建数据库记录；创建有全站串行准入和硬数量限制。达到资源上限后拒绝新操作，已有日志不会被静默删掉；管理员可先导出，再删除不再需要的房间。应用仅缓存最多 64 个房间，并将缓存内状态/日志的 JSON 字节总量限制到 24 MiB（解析后的实际堆占用更大）；同时限制单房间消息队列、消息大小和慢客户端发送缓冲。

管理员登录 session 保存在服务器，Cookie 为 HttpOnly/SameSite=Strict，HTTPS 时设置 Secure，8 小时过期。结束/删除/退出登录要求 Origin 和 CSRF 凭证；退出或凭证修改会撤销 session。管理员观看连接独立于玩家和其他管理员。结束对局会保存原因与审计记录；删除会断开全部连接并移除对局和日志，保留有界操作审计，不会被延迟的连接关闭事件重新创建。

Docker 还限制 384 MiB 内存、1 CPU、64 个进程，使用非 root 用户、只读根文件系统、移除 capabilities，并轮转运行日志。应用限流不能吸收超过服务器带宽的网络攻击；公网入口仍由 Nginx/上游网络防护承担。

## 数据备份与旧 Cloudflare 模式

备份前停止应用或使用 SQLite 在线备份工具；不要只复制正在写入的主库而遗漏 WAL。命名卷包含 `hidden-crown.sqlite` 及其 WAL 文件。请勿运行 `docker compose down -v`，这会删除数据卷。

旧的 `src/room.ts` / `wrangler.jsonc` 适配器仍保留用于兼容测试，共用棋局核心。**当前全局管理员和资源准入防护由自托管 Node 服务实现，不能把 Wrangler 预览当成具备同等管理能力的生产部署。** 两种后端的存储相互独立，旧 `.wrangler/` 数据不会自动迁移到 SQLite。

实现参考：[Nginx WebSocket 反代](https://nginx.org/en/docs/http/websocket.html)、[Docker 多平台构建](https://docs.docker.com/build/ci/github-actions/multi-platform/)、[Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/)。
