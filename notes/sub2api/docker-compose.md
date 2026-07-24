# Docker Compose 部署 Sub2API

## 推荐：使用 Docker Compose 安装

Sub2API 官方推荐 Docker Compose 部署，会同时启动 Sub2API、PostgreSQL 和 Redis。当前镜像支持 `amd64` 与 `arm64`，可部署在安装了 Docker Engine 和 Docker Compose 的服务器或 NAS 上。([GitHub][1])

### 1. 创建部署目录

创建一个独立目录并进入该目录：

```bash
mkdir sub2api
cd sub2api
```

在这个目录中创建 `docker-compose.yml`。下面使用相对目录持久化数据，方便备份和迁移。

### 2. 粘贴以下配置

下面已经生成了一套随机数据库密码、Redis 密码和加密密钥，可以直接部署。管理员登录信息在代码后面。

```yaml
services:
  sub2api:
    image: weishaw/sub2api:latest
    container_name: sub2api
    restart: unless-stopped
    ports:
      - "18080:8080"
    volumes:
      - ./data:/app/data
    environment:
      AUTO_SETUP: "true"

      SERVER_HOST: "0.0.0.0"
      SERVER_PORT: "8080"
      SERVER_MODE: "release"
      RUN_MODE: "standard"

      DATABASE_HOST: "postgres"
      DATABASE_PORT: "5432"
      DATABASE_USER: "sub2api"
      DATABASE_PASSWORD: "3d71f3924ecbb04be4cc9c28e34b78f691efecd036516634"
      DATABASE_DBNAME: "sub2api"
      DATABASE_SSLMODE: "disable"
      DATABASE_MAX_OPEN_CONNS: "50"
      DATABASE_MAX_IDLE_CONNS: "10"

      REDIS_HOST: "redis"
      REDIS_PORT: "6379"
      REDIS_PASSWORD: "0157fc4db2b0b3e2e413ada458b1fcb441ca382cb81e9e60"
      REDIS_DB: "0"

      ADMIN_EMAIL: "admin@sub2api.local"
      ADMIN_PASSWORD: "nfyZbHpm68l8Etgkqzov6xjh"

      JWT_SECRET: "f962984f2d7a048b2054c8f437fe7d9db4cd37520ad4d252780ae89605882d2a"
      TOTP_ENCRYPTION_KEY: "35020aff8412f68bf13ee22f4bdfd9ca8f28d958cde886cd88d090a9a4a335cc"

      TZ: "Europe/Amsterdam"

      SECURITY_URL_ALLOWLIST_ENABLED: "false"
      SECURITY_URL_ALLOWLIST_ALLOW_INSECURE_HTTP: "true"
      SECURITY_URL_ALLOWLIST_ALLOW_PRIVATE_HOSTS: "true"

    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    networks:
      - sub2api-network
    healthcheck:
      test:
        - CMD
        - wget
        - -q
        - -T
        - "5"
        - -O
        - /dev/null
        - http://localhost:8080/health
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s

  postgres:
    image: postgres:18-alpine
    container_name: sub2api-postgres
    restart: unless-stopped
    volumes:
      - ./postgres_data:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: "sub2api"
      POSTGRES_PASSWORD: "3d71f3924ecbb04be4cc9c28e34b78f691efecd036516634"
      POSTGRES_DB: "sub2api"
      PGDATA: "/var/lib/postgresql/data"
      TZ: "Europe/Amsterdam"
    networks:
      - sub2api-network
    healthcheck:
      test:
        - CMD-SHELL
        - pg_isready -U sub2api -d sub2api
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s

  redis:
    image: redis:8-alpine
    container_name: sub2api-redis
    restart: unless-stopped
    volumes:
      - ./redis_data:/data
    command: >
      sh -c 'redis-server
      --save 60 1
      --appendonly yes
      --appendfsync everysec
      --requirepass "0157fc4db2b0b3e2e413ada458b1fcb441ca382cb81e9e60"'
    environment:
      REDISCLI_AUTH: "0157fc4db2b0b3e2e413ada458b1fcb441ca382cb81e9e60"
      TZ: "Europe/Amsterdam"
    networks:
      - sub2api-network
    healthcheck:
      test:
        - CMD
        - redis-cli
        - ping
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 5s

networks:
  sub2api-network:
    driver: bridge
```

这份配置采用官方当前使用的 `weishaw/sub2api:latest`、`postgres:18-alpine` 和 `redis:8-alpine`，并使用本地目录保存应用、数据库和 Redis 数据。([GitHub][2])

### 3. 启动并登录

在 `docker-compose.yml` 所在目录执行：

```bash
docker compose up -d
```

查看容器状态：

```bash
docker compose ps
```

等待三个容器都显示运行或健康，然后在浏览器打开 `http://localhost:8080`。如果 Docker 运行在远程服务器或 NAS 上，则访问：

```text
http://服务器IP:8080
```

登录信息：

```text
邮箱：admin@sub2api.local
密码：nfyZbHpm68l8Etgkqzov6xjh
```

首次登录后建议立即修改管理员密码。官方默认访问端口也是 `8080`。([GitHub][1])

如果 `8080` 已被占用，把：

```yaml
- "8080:8080"
```

改成：

```yaml
- "18080:8080"
```

然后访问：

```text
http://服务器IP:18080
```

## 数据目录与备份

部署目录中会产生：

```text
data
postgres_data
redis_data
```

备份前先在部署目录停止服务：

```bash
docker compose down
```

然后完整备份这三个数据目录以及 `docker-compose.yml`。恢复或完成备份后，执行 `docker compose up -d` 重新启动服务。官方也推荐这种本地目录方案，因为迁移和备份比 Docker 命名卷更方便。([GitHub][1])

## 外网访问注意

不要直接把 `8080` 管理端口暴露到公网，建议通过 HTTPS 反向代理访问。如果使用 Nginx 反代并配合 Codex CLI，需要在 Nginx 的 `http` 配置段启用：

```nginx
underscores_in_headers on;
```

否则 Nginx 可能删除 `session_id` 等带下划线的请求头，影响粘性会话。([GitHub][1])

该项目也明确提示：通过订阅账号中转请求可能违反部分上游服务商的使用条款，部署和使用前需要自行确认 Anthropic、OpenAI 等服务的相关规定。([GitHub][1])

[1]: https://github.com/Wei-Shaw/sub2api "GitHub - Wei-Shaw/sub2api: Sub2API 一站式开源中转服务，让 Claude、Openai、Gemini、Grok 订阅统一接入，支持拼车共享，更高效分摊成本，原生工具无缝使用。"
[2]: https://raw.githubusercontent.com/Wei-Shaw/sub2api/main/deploy/docker-compose.local.yml "docker-compose.local.yml"
