<!-- 本文件由 drawing-engine/gen-icon-reference.js 从 drawing-engine/topology-icons/catalog.json 生成，不要手改。 -->
<!-- 改图标目录请改 catalog.json 后重新生成；verify-icon-reference.js 会校验两者是否一致。 -->

# 图标目录

共 35 个 key。按语义挑，不要跟角色名做字符串匹配。

## 交换机

- `core-switch` — 核心交换机
- `agg-switch` — 汇聚交换机
- `access-switch` — 接入交换机
- `generic-switch` — 通用交换机
- `stacked-switch` — 堆叠交换机
- `tor-switch` — TOR交换机

## 路由器

- `core-router` — 核心路由器
- `generic-router` — 通用路由器

## 安全设备

- `firewall` — 防火墙
- `virtual-firewall` — 虚拟防火墙
- `nip` — NIP入侵防御
- `anti-ddos` — Anti-DDoS清洗检测设备
- `load-balancer` — 负载均衡器

## 无线

- `ap` — AP
- `ac` — AC无线控制器
- `antenna-indoor` — 室内天线
- `antenna-outdoor` — 室外天线

## 云 / 虚拟化

- `cloud-computing` — 云计算
- `network-cloud` — 网络云
- `virtualization-platform` — 虚拟化管理平台
- `vm` — 虚拟机
- `vswitch` — vSwitch

## 服务器与存储

- `web-server` — Web服务器
- `ftp-server` — FTP服务器
- `mail-server` — 邮件服务器
- `database` — 数据库
- `storage-array` — 存储阵列
- `generic-server` — 通用服务器

## 终端

- `pc` — PC
- `laptop` — 笔记本电脑
- `ip-phone` — IP电话
- `printer` — 打印机

## 通用

- `internet` — Internet

## 管理

- `nms-generic` — 通用网管
- `admin` — 网络管理员

## iconTheme 的例外

下面 4 个 key 只有蓝色版、没有黄色版，设 `iconTheme: "yellow"` 对它们不生效（它们不是"设备"）：`cloud-computing`、`network-cloud`、`internet`、`admin`。
