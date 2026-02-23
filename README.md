# Tauri 2.0 SSH Client (React)

一个基于 Tauri 2.0 + React + Rust 的桌面 SSH 客户端骨架，内置：

- 多 Tab 会话管理
- SSH 会话保持（keepalive + last active）
- 交互式终端（xterm.js + PTY shell）
- 远程命令执行
- SFTP 目录浏览、上传、下载

## 技术栈

- 前端：React + TypeScript + Vite
- 桌面壳：Tauri 2.0
- 后端：Rust + ssh2

## 启动

1. 安装依赖：

```bash
npm install
```

2. 启动开发：

```bash
npm run tauri dev
```

## 目录结构

- `src/` React 前端
- `src-tauri/src/main.rs` SSH/SFTP 会话池与 Tauri 命令
- `src-tauri/tauri.conf.json` Tauri 配置

## 当前实现边界

- 已支持交互式终端，同时保留按次执行命令（`run_command`）用于脚本化查询。
- 主机指纹校验、连接配置持久化、下载上传进度和断点续传尚未加入。

## 建议下一步

- 接入 xterm.js + ssh channel 交互流，支持真正终端体验
- 加已知主机指纹管理（known_hosts）
- 将连接配置与会话状态持久化到本地数据库（如 SQLite）
