# Docker + Nginx 自托管

当前生产部署使用 Node.js 24 + SQLite，所有房间、走棋与日志均保存在自己的服务器。无需 Cloudflare 账号或云数据库。一次只运行一个应用实例；多实例不能共享同一个 SQLite 文件来实现跨进程实时对局。

## 使用 Compose 拉取镜像（推荐）

服务器只需要 Docker Engine、Compose 插件，以及现有 Nginx 和 HTTPS 证书；无需安装 Node.js、SQLite 或下载源码。

从个人私有仓库 `KKazuhaK/hidden-crown` 的 Releases 下载 `hidden-crown-compose.zip`，上传到服务器并解压到独立目录。包内包含 Compose、`.env.example`、说明和 Nginx 示例配置。

```bash
unzip hidden-crown-compose.zip
cp .env.example .env
chmod 600 .env
nano .env
```

在 `.env` 中集中配置：

```dotenv
PUBLIC_ORIGIN=https://chess.your-domain.com
ADMIN_USERNAME=admin
ADMIN_PASSWORD='填写你自己的16至256字符密码'
HOST_PORT=8787
HIDDEN_CROWN_IMAGE=ghcr.io/kkazuhak/hidden-crown:1.0.0
WAITING_TIMEOUT_MINUTES=15
TRUSTED_PROXIES=
```

`PUBLIC_ORIGIN` 必须与浏览器访问的 HTTPS 地址完全一致。密码没有默认值；保留空密码会阻止启动。用单引号包住密码可保留 `$` 等字面字符，密码若包含单引号则按 Compose `.env` 语法转义。配置文件不会上传到 GitHub。管理员从 `/admin` 登录。

源码仓库保持私有；部署镜像按用户授权设为公开，普通拉取不需要 GitHub 登录。完成配置后：

```bash
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=50
```

Docker 自动选择 AMD64 或 ARM64 镜像。SQLite 使用命名卷 `hidden-crown-data`，重建、升级不会丢掉对局。默认仅向宿主机 `127.0.0.1:8787` 发布端口。保持部署目录/Compose 项目名稳定，避免另建一个空数据卷；不要运行 `docker compose down -v`。

普通配置修改后执行 `docker compose up -d`。`WAITING_TIMEOUT_MINUTES` 仅用于新数据库初始化；已有等待时限通过管理员后台修改。升级时修改 `HIDDEN_CROWN_IMAGE` 的版本，然后执行 `docker compose pull && docker compose up -d`；版本固定便于回滚，也可主动选用 `latest` 自动跟随稳定发布。

## 使用 `/opt/hidden-crown/data` 保存数据

仓库提供独立的 [docker-compose.bind.yml](docker-compose.bind.yml) 模板，适合把配置和数据都放在 `/opt/hidden-crown`。首次部署时，将此模板保存为该目录的 `docker-compose.yml`，同时把 `.env.example` 保存为 `.env`：

```text
/opt/hidden-crown/
├── docker-compose.yml  # 使用 docker-compose.bind.yml 的内容
├── .env
└── data/
    ├── hidden-crown.sqlite
    └── ...            # SQLite 的 WAL/SHM 等文件
```

```bash
sudo mkdir -p /opt/hidden-crown
sudo install -d -m 700 -o 1000 -g 1000 /opt/hidden-crown/data
cd /opt/hidden-crown
# 将模板放入此目录，编辑 .env 中的域名和管理员密码。
chmod 600 .env
docker compose pull
docker compose up -d
docker compose ps
```

镜像以 UID/GID `1000:1000` 运行，因此必须先创建具有正确所有权的数据目录；模板不会自动创建一个 root 所有的目录。`DATA_DIR` 默认是 Compose 文件旁的 `./data`，也可在 `.env` 中指定其他绝对路径。Nginx 仍反代到 `127.0.0.1:8787`。

源码仓库为私有：登录 GitHub 后可查看或下载模板，服务器不能直接匿名 `curl` 私有仓库的 Raw URL。只需上传这两个配置文件，镜像可以匿名拉取。现有命名卷部署不要直接替换模板；切换存储前先停机，将原数据卷的全部内容复制到新目录并设置所有权，否则会打开一个新数据库。

备份目录时先执行 `docker compose stop`，完整备份 `data/` 后再执行 `docker compose start`。更新镜像和重建容器都会继续使用同一目录。

## 可选：使用密码文件

默认把账号密码集中在 `.env`，无需另建 secrets 文件。偏好密码文件的用户可用 `docker-compose.secrets.yml` 覆盖：把 `.env` 中 `ADMIN_PASSWORD` 设为 `using-password-file`（满足基础配置检查，最终容器环境会清空此值），并创建文件：

```bash
mkdir -p secrets
chmod 700 secrets
nano secrets/admin-password.txt
sudo chown 1000:1000 secrets/admin-password.txt
sudo chmod 600 secrets/admin-password.txt
docker compose -f docker-compose.yml -f docker-compose.secrets.yml up -d
```

更新和查看日志时也使用同样的两个 `-f` 参数。

## 可选：从源码构建

源码目录中仍可以使用上述 `.env` 配置运行：

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Nginx

把 `deploy/nginx.conf` 放入 Nginx 的 `http {}` 配置范围（例如 `conf.d/hidden-crown.conf`），把 `deploy/hidden-crown-proxy.conf` 放到 `/etc/nginx/snippets/hidden-crown-proxy.conf`。替换示例域名和证书路径，后端端口与 `.env` 的 `HOST_PORT` 保持一致。保留 WebSocket 的 Upgrade/Connection 头和超时设置。

```bash
sudo nginx -t
sudo systemctl reload nginx
```

反代配置会覆盖客户端传来的 `X-Forwarded-For`。`.env` 的 `TRUSTED_PROXIES` 只填写应用容器实际看到的 Nginx 来源 IP（精确地址，逗号分隔；不支持 CIDR）。宿主机 Nginx 连接 Docker 发布端口时，这通常是该 Compose 网络的网关；可通过 `docker network inspect <项目名>_default` 核对。默认留空会忽略转发头，安全但会把同一代理后的用户合并计入同一个 IP 限额。不要信任任意地址或使用 `$proxy_add_x_forwarded_for` 来保留不可信前缀。

Nginx 在容器内时，需要让它和应用在同一个受控 Docker 网络中，并将反代 upstream 改为 `http://hidden-crown:8787`。同时填写它的确切容器 IP；不要把后端端口直接暴露到公网。

## 镜像发布机制

版本标签 `v1.0.0` 等触发 Release，先在原生 AMD64、ARM64 runner 验证引擎、服务端、容器、Compose 登录、持久化与 Nginx 配置，再构建两种架构并发布到 `ghcr.io/kkazuhak/hidden-crown`。每个发布包括精确版本标签、稳定版 `latest`、最近发布版 `beta` 和只含部署配置的 `hidden-crown-compose.zip`。手动发布也必须选择已有版本标签；精确版本不重复覆盖。

镜像公开用于匿名拉取，源码仓库保持私有。发布包内的 `.env.example` 固定为该次发布的镜像版本。已完成的发布可在 [Releases](https://github.com/KKazuhaK/hidden-crown/releases) 查看；只有 Release 工作流成功后对应镜像才能拉取。升级前先备份数据卷。

## 默认防护与可调限额

| 范围 | 默认值 | 配置 |
| --- | --- | --- |
| 单 IP 创建房间 | 10 分钟容量 5，持续补充 | `CREATE_LIMIT_PER_IP` |
| 全站创建房间 | 10 分钟容量 50，持续补充 | `CREATE_LIMIT_GLOBAL` |
| 未开始对局等待上限 | 创建后 15 分钟 | `WAITING_TIMEOUT_MINUTES`（首次初始化）；后台持久化设置优先 |
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

后台可设置 1–1440 分钟的等待开局上限，设置保存在 SQLite 中，重启后保留。超时仅清理等待玩家与选择王冠的房间，时间从创建时计算，加入或重连不重置。对弈中及已结束的记录保留。服务启动、创建/加入/列表请求以及每 5 秒的后台扫描都会清理超时房间；缩短设置会立即清理已超时的房间，连接断开且记录永久删除。`WAITING_TIMEOUT_MINUTES` 仅指定新数据库的初始值，不覆盖已有后台设置。

管理员列表的“玩家链接”可获取、复制或打开对应白方/黑方入口；请仅分享给对应玩家，因为专属链接会替换该玩家已有连接。玩家及管理员观战界面的走棋回放支持拖动时间线、逐步查看及点击走棋记录跳转；回放不会改变服务端棋局，查看历史期间不能提交游戏操作。

Docker 还限制 384 MiB 内存、1 CPU、64 个进程，使用非 root 用户、只读根文件系统、移除 capabilities，并轮转运行日志。应用限流不能吸收超过服务器带宽的网络攻击；公网入口仍由 Nginx/上游网络防护承担。

## 数据备份与旧 Cloudflare 模式

备份前停止应用或使用 SQLite 在线备份工具；不要只复制正在写入的主库而遗漏 WAL。命名卷包含 `hidden-crown.sqlite` 及其 WAL 文件。请勿运行 `docker compose down -v`，这会删除数据卷。

旧的 `src/room.ts` / `wrangler.jsonc` 适配器仍保留用于兼容测试，共用棋局核心。**当前全局管理员和资源准入防护由自托管 Node 服务实现，不能把 Wrangler 预览当成具备同等管理能力的生产部署。** 两种后端的存储相互独立，旧 `.wrangler/` 数据不会自动迁移到 SQLite。

实现参考：[Nginx WebSocket 反代](https://nginx.org/en/docs/http/websocket.html)、[Docker 多平台构建](https://docs.docker.com/build/ci/github-actions/multi-platform/)、[Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/)。
