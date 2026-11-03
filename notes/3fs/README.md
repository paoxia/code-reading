# 3FS：元数据、CRAQ 存储与原生 I/O

## 研究范围与版本

- 复核日期：2026-11-02。
- 本地源码版本：`22fca04564c7cc230fd8b9523b8b92864e1dad47`（提交日期 2026-05-07）。
- 范围：入口、核心抽象、主要执行链及接口限制；基于本地源码静态分析，没有运行硬件测试或性能基准。

## 整体架构

3FS 将文件系统拆成 cluster manager、metadata service、storage service 与 client。它面向共享高吞吐数据访问，能承载训练数据、checkpoint 和推理缓存等负载，但不是推理引擎内部的 GPU KV 分配器。

| 核心对象 | 源码入口 | 职责 |
| --- | --- | --- |
| Mgmtd | [src/mgmtd](../../code/3fs/src/mgmtd) | 成员、心跳、拓扑与集群配置 |
| Meta service | [src/meta](../../code/3fs/src/meta) | inode、目录项与事务语义 |
| Storage service | [src/storage/service/StorageService.cc](../../code/3fs/src/storage/service/StorageService.cc) | chunk 存储、复制与请求处理 |
| StorageClient | [src/client/storage/StorageClient.cc](../../code/3fs/src/client/storage/StorageClient.cc) | 客户端数据请求与存储节点通信 |
| FUSE | [src/fuse](../../code/3fs/src/fuse) | 文件系统接入与原生 I/O 衔接 |

## 主要执行链

```text
open/create → MetaClient → Meta service → FoundationDB
read/write → 按 layout 计算 chunk / chain
  → StorageClient → CRAQ replicas → completion
Mgmtd → 分发成员与布局配置
```

## 关键机制与扩展边界

元数据服务以事务 KV 存储为后端，文件打开后返回 layout，客户端据此计算 chunk 与复制链，数据访问不必每次经过元数据服务。CRAQ 路径将数据复制与读策略独立于目录操作。

原生 I/O 使用共享内存区域与环形请求队列（Iov/Ior）减少数据搬运；高性能数据路径可以与 FUSE 元数据操作配合。研究一致性时要分别看 namespace 事务、chunk 复制与客户端可见性。

## 深入：USRBIO 的提交通知不是 I/O 的原子起点

[USRBIO API](../../code/3fs/src/lib/api/UsrbIo.md) 将 Iov、Ior、注册 fd 和 completion 分开。`hf3fs_prep_io()` 的 buffer 区间必须完全位于 Iov，fd 必须先注册；userdata 在 completion 时回传，供调用者关联请求。

```text
创建 Iov/Ior → 注册 fd
  → prep_io 写入请求
  → submit_ios 通知 FUSE（后台也会周期扫描）
  → wait_for_ios 收集完成与每项结果
  → 依据完成事实复用相应 buffer
```

文档明确 I/O 可能在调用 submit_ios 之前执行，因为后端会扫描队列。不能在 prep 后、submit 前假定请求尚未被读取，再修改同一 buffer；submit 返回 0 也不能替代 completion 结果。prep 接口还注明可能非线程安全，共享 Ior 需要额外协调。

## 深入：本地写入与副本提交分开

[StorageClient](../../code/3fs/src/client/storage/StorageClient.cc) 为 write/remove/truncate 等操作建立 RequestId、chain/chunk 与 buffer 描述；[ChunkReplica](../../code/3fs/src/storage/store/ChunkReplica.cc) 继续区分 updateVer、commitVer、chain version 与 dirty 状态。

源码明确本地写失败可以使 chunk 变 dirty，普通 commit 对 dirty 状态返回错误；提交版本也不能超过已更新版本。由此不能把“一台 SSD 的写调用结束”当作整条复制链已提交，或把存储错误自动解释成所有已写数据都已回滚。

本轮只沿接口和副本局部状态定位，没有运行故障注入，也没有据局部代码声称完成了整个 CRAQ 协议的形式化证明。

## 限制与注意事项

README 的集群吞吐数据来自特定 SSD/RDMA 集群，本笔记没有复现。部署依赖 FoundationDB、网络和系统组件；存储容量与带宽不能直接换算成模型 token 吞吐。

## 推荐阅读顺序

先读上述入口和公共接口，再沿执行链进入底层实现，最后对照 [tests/storage](../../code/3fs/tests/storage) 的示例或测试材料理解边界条件。示例与测试在本轮只作为源码证据阅读，未实际执行。

横向定位见 [AI 基础设施分层与阅读路线](../../summary/ai-infrastructure/architecture-and-reading-guide.md)。
