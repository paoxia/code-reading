# Sub2API Docker Compose：配置来源与部署结构

> 本轮复核：2026-11-02；本地源码 `4a4a83ee5ec86b19d3a2dd9b6471de5128963bec`（提交日期 2026-11-02）。基于本地源码与测试材料静态分析，未运行上游构建、测试或性能基准。

## 当前源码依据

本轮以本地 deploy 配置为准，替换旧笔记中硬编码凭据和整份复制配置的示例。当前可读：[本地目录 Compose](../../code/sub2api/deploy/docker-compose.local.yml)、[默认 Compose](../../code/sub2api/deploy/docker-compose.yml)、[外部数据库/缓存 Compose](../../code/sub2api/deploy/docker-compose.standalone.yml) 与 [环境模板](../../code/sub2api/deploy/.env.example)。

本文解释部署结构和准备方式，本轮没有启动容器或验证线上服务。

## 组件和数据

```text
Client → Sub2API :8080
              ├─ PostgreSQL：业务数据
              └─ Redis：缓存与并发相关状态
```

local 配置用 data、postgres_data 和 redis_data 持久化对应数据，PostgreSQL/Redis 通过 Compose 内部网络访问。应用启动依赖数据库和缓存健康检查，但 health endpoint 成功不代表所有上游账号转发都已经可用。

## 使用已复核的本地模板

从阅读仓库根目录准备一个独立部署目录，复用上游模板：

```bash
mkdir -p sub2api-deploy
cp code/sub2api/deploy/docker-compose.local.yml sub2api-deploy/docker-compose.yml
cp code/sub2api/deploy/.env.example sub2api-deploy/.env
cd sub2api-deploy
chmod 600 .env
```

填写 .env 后再执行 `docker compose config` 检查配置，确认后由部署者运行 `docker compose up -d`。不要直接沿用笔记里已公开的示例密码；旧文章中的固定值已移除。需要可复现部署时，镜像 tag/digest 和配置应与实际验证版本一起记录，`latest` 不固定上游内容。

## 需要明确的配置

| 字段 | 作用与当前合同 |
| --- | --- |
| POSTGRES_PASSWORD | local 模板声明为必填，由应用 DATABASE_PASSWORD 和数据库共同使用 |
| REDIS_PASSWORD | 应用和 Redis 的认证配置保持一致 |
| ADMIN_EMAIL / ADMIN_PASSWORD | 首次自动安装的管理员初始化参数 |
| JWT_SECRET | 固定后避免重启改变签名身份 |
| TOTP_ENCRYPTION_KEY | 与已加密的 TOTP 数据配套保存 |
| BIND_HOST / SERVER_PORT | 宿主监听地址和端口映射 |
| TZ | 当前模板默认 Asia/Shanghai |

完整参数以环境模板和配置加载实现为准。已有数据库的管理员密码不应被理解为每次重启都会由初始化变量重设。

## 数据迁移与更新

备份应包含数据库、应用持久化数据和与加密数据对应的密钥，不能只复制 Compose 文件。版本升级前先确认上游 migration 与镜像兼容性；回退镜像不自动回退数据库。

standalone 配置连接外部数据库/Redis，本地三个 service 的假设不适用于该模式。账号、协议和客户端接入继续看 [网关架构](../sub2api/README.md) 与 [客户端接入](./client-integration.md)。
