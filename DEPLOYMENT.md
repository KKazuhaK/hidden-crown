# Hidden Crown 2.0：Docker Compose + Nginx

Node.js 24 + WebSocket。留空 `DATABASE_URL` 使用 SQLite；填写 PostgreSQL URL 则连接现有 PostgreSQL 14+。Redis、MySQL 均不是依赖。源码仓库私有，GHCR 镜像和 [部署模板仓库](https://github.com/KKazuhaK/hidden-crown-deploy) 公开，可匿名拉取。

## 连接你已有的 PostgreSQL

使用独立数据库和独立角色，数据库所有者应为应用角色。以下 SQL 由你在 PostgreSQL 管理工具中执行，密码换成自己的：

```sql
CREATE ROLE hidden_crown LOGIN PASSWORD '替换为数据库密码';
CREATE DATABASE hidden_crown OWNER hidden_crown;
```

应用启动时自动创建 `hc_` 前缀的表、索引和版本迁移记录。应用角色无需超级用户或创建其他数据库的权限，但需要创建及维护自己的表。不要连接其他项目正在使用的数据库。

在服务器上：

```bash
sudo mkdir -p /opt/hidden-crown
cd /opt/hidden-crown
sudo wget -O docker-compose.yml https://raw.githubusercontent.com/KKazuhaK/hidden-crown-deploy/main/docker-compose.postgres.yml
sudo wget -O .env.example https://raw.githubusercontent.com/KKazuhaK/hidden-crown-deploy/main/.env.example
sudo cp .env.example .env
sudo chmod 600 .env
sudo nano .env
```

配置：

```dotenv
PUBLIC_ORIGIN=https://chess.your-domain.com
ADMIN_USERNAME=admin
ADMIN_PASSWORD='你自己的16至256字符管理员密码'
HIDDEN_CROWN_IMAGE=ghcr.io/kkazuhak/hidden-crown:2.0.0
HOST_PORT=8787
DATABASE_URL='postgresql://hidden_crown:URL编码后的数据库密码@host.docker.internal:5432/hidden_crown'
PG_POOL_MAX=10
TRUSTED_PROXIES=
```

管理员密码和数据库密码是两套凭证。URL 中用户名、密码的 `@`、`:`、`/`、`#`、`%` 等保留字符需要进行百分号编码。可设置 `DATABASE_URL_FILE` 读取只读挂载的连接文件；不要把连接文件提交到仓库。

`docker-compose.postgres.yml` 是完整模板，只启动应用，不启动额外数据库，也不挂载 SQLite 数据目录。它添加 `host.docker.internal:host-gateway`，方便连接宿主机上的 PostgreSQL。容器内的 `127.0.0.1` 是容器自己。宿主 PostgreSQL 必须监听容器可以访问的地址，`pg_hba.conf` 也要允许应用所在 Docker 子网和应用角色；只开放必要的来源。如果 PostgreSQL 是已有容器，也可让应用加入它的 Docker 网络，并在 URL 中使用数据库服务名。

```bash
sudo docker compose config --quiet
sudo docker compose pull
sudo docker compose up -d
sudo docker compose ps
sudo docker compose logs --tail=50
```

对外访问前配置现有 Nginx 和 HTTPS。应用默认只向宿主机 `127.0.0.1:8787` 发布端口。`PUBLIC_ORIGIN` 必须与浏览器使用的 HTTPS 地址一致；管理员访问 `/admin`。

## SQLite 快速测试或独立部署

`docker-compose.yml` 使用命名卷；`docker-compose.bind.yml` 使用 `./data`。公开部署仓库的 `docker-compose.yml` 对应 bind 模板，适合你的目录习惯：

```text
/opt/hidden-crown/
├── docker-compose.yml
├── .env
└── data/
    ├── hidden-crown-v2.sqlite
    └── ...                  # WAL/SHM 文件
```

首次安装可运行公开仓库的 `install.sh`，或下载模板后手动设置：

```bash
sudo mkdir -p /opt/hidden-crown
sudo install -d -m 700 -o 1000 -g 1000 /opt/hidden-crown/data
cd /opt/hidden-crown
sudo wget -O docker-compose.yml https://raw.githubusercontent.com/KKazuhaK/hidden-crown-deploy/main/docker-compose.yml
sudo wget -O .env.example https://raw.githubusercontent.com/KKazuhaK/hidden-crown-deploy/main/.env.example
sudo cp .env.example .env
sudo chmod 600 .env
sudo nano .env
# 留空 DATABASE_URL，设置域名和管理员密码。
sudo docker compose pull
sudo docker compose up -d
```

应用以 UID/GID `1000:1000` 运行；bind 模板要求预先创建正确所有权的数据目录。SQLite 的查询、事务和磁盘写入在独立 Worker 线程执行，主线程处理连接及规则。默认 WAL + FULL 同步，启用外键和级联删除。数据结构、对局和管理功能与 PostgreSQL 一致。

本地不需要 PostgreSQL：安装 Node.js 24 后，`npm ci`、设置 `ADMIN_PASSWORD`，再运行 `npm run dev`。默认使用 `data/hidden-crown-v2.sqlite`。填写本地 `DATABASE_URL` 可以验证 PostgreSQL。

## 从 1.x 重新部署

2.0 是新的存储结构，按本次重新部署决定使用新库，不自动导入 1.x 对局。SQLite 默认文件改为 `hidden-crown-v2.sqlite`，原文件保留。PostgreSQL 使用新建的 `hidden_crown` 数据库。原链接不会在新库中恢复。

先从旧后台导出需要保留的对局。停止旧 Compose 项目后，在部署目录换成所需 2.0 模板、设置新 `.env`，再拉取并启动。不要删除旧数据目录或运行旧项目的 `down -v` 来清理数据；保留旧数据库便于查阅或回退。回退 1.x 镜像时使用原来的模板和原数据库。

后续 2.x 升级有版本迁移记录；迁移在事务内执行。保持项目名、数据目录或数据库 URL 不变，修改镜像版本后执行 `docker compose pull` 和 `docker compose up -d`。

## Nginx 与真实客户端 IP

`deploy/nginx.conf` 放在 Nginx `http {}` 范围内，代理片段保存为 `/etc/nginx/snippets/hidden-crown-proxy.conf`。替换域名和 HTTPS 证书路径，反代至 `http://127.0.0.1:8787`，保留 WebSocket Upgrade/Connection 头。

```bash
sudo nginx -t
sudo systemctl reload nginx
```

代理片段覆盖 `X-Forwarded-For`。`TRUSTED_PROXIES` 填应用实际看到的 Nginx 来源 IP，精确地址、逗号分隔。宿主 Nginx 常从 Compose 网关连接，可用 `docker network inspect <项目名>_default` 核对。留空会忽略转发头，所有代理后的玩家会共享该代理的 IP 限额，因此正式开放前必须正确设置。不要信任任意地址，也不要保留客户端提供的不可信转发链。

## 可调容量和防护

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `CREATE_LIMIT_PER_IP` | 5 | 每 10 分钟创建令牌容量，持续补充 |
| `CREATE_LIMIT_GLOBAL` | 100 | 全站每 10 分钟创建令牌容量 |
| `WAITING_TIMEOUT_MINUTES` | 15 | 新库的等待开局时限；已有库用后台设置 |
| `MAX_ROOMS` | 10000 | 全部保存对局的数量上限 |
| `MAX_ACTIVE_ROOMS` | 256 | 未结束房间的准入上限，包含等待房间 |
| `MAX_LOADED_ROOMS` | 256 | 进程中加载的房间上限 |
| `MAX_CONNECTIONS` | 512 | WebSocket 总连接上限 |
| `MAX_CACHE_BYTES` | 64 MiB | 房间缓存的保守字节预算；不是进程 RSS 硬上限 |
| `MAX_ROOM_BYTES` | 4 MiB | 每个房间快照、走棋和事件的存储上限 |
| `MAX_STORED_BYTES` | 768 MiB | 保存对局数据达到此值时拒绝创建新房间；已有对局可继续增长至单房间上限 |
| `MAX_DATABASE_BYTES` | 1 GiB | SQLite 主库页空间上限，另留 WAL 余量；不限制 PostgreSQL 物理大小 |
| `PG_POOL_MAX` | 10 | PostgreSQL 连接池总数，包括 1 个实例所有权连接 |

限流、载入房间、每房间队列、每连接输入队列、消息大小、慢客户端发送缓冲均有界。空闲房间按最近使用顺序从缓存移出，不移除在线或处理中房间。管理员可以从 `/api/admin/metrics` 查看后端、房间数量、连接、内存和事件循环延迟，不会返回王冠或凭证。

等待超时从创建起计算，重连不重置。仅清理 `lobby` / `crown_select`；开始及结束的对局保留。每 5 秒分批扫描，后台缩短时限会触发清理。历史达到容量后管理员可先导出，再删除，不会自动删除已结束对局。

管理员会话存储在所选数据库，Cookie 为 HttpOnly/SameSite=Strict，HTTPS 下 Secure，8 小时过期。变更操作要求 Origin 和 CSRF。退出及账号密码改变撤销会话。删除事务通过外键清除走棋、事件和房间关联的审计记录，只保留不关联房间数据的删除操作审计；延迟的消息或关闭事件不能重建被删除对局。

默认容器为非 root、只读根文件系统、移除 capabilities、限制 384 MiB 内存 / 1 CPU / 64 个进程，并轮转日志。这些是可调整的防护边界，不是已验证的服务器人数保证。约 100 人在线已做本地模拟，实际服务器仍应验证 CPU、内存和磁盘性能。

## 单实例边界与扩展

目前一个应用实例拥有实时连接及房间队列。PostgreSQL 通过会话 advisory lock 阻止第二个应用同时占用同一数据库，避免缓存状态和广播分裂。不要直接使用 `docker compose --scale`。将来多实例需要在 `RoomManager` 边界增加房间归属与路由，并增加跨实例广播；届时再接入 Redis。

规则实现通过 `RuleSet` / `RuleRegistry` 接口注册，房间保存固定的玩法 ID、版本和选项。新的胜负条件、开局布局和额外动作不需要改动数据库或认证层。详见 README 的扩展接口部分。

## 备份与其他部署文件

PostgreSQL 用现有数据库备份体系或 `pg_dump`；备份的是 PostgreSQL 数据库，应用容器的数据目录不是 PostgreSQL 备份。SQLite 停止应用后备份完整 `data/`，或使用 SQLite 在线备份工具，不能只复制正在写入的主库而遗漏 WAL。

`docker-compose.secrets.yml` 可提供管理员密码文件；`.env` 用 `ADMIN_PASSWORD=using-password-file` 满足基础配置检查，文件挂载为应用用户可读。`docker-compose.build.yml` 支持源码构建。Releases 的 `hidden-crown-compose.zip` 包含所有模板、环境示例和 Nginx 文件。

Cloudflare 适配器保留并共用规则和房间核心；它不具备自托管服务的全局管理员及容量管理，不作为本次生产部署方案。
