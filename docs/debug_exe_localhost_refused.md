# target/debug/fs-gui.exe 报「localhost 拒绝连接 / ERR_CONNECTION_REFUSED」

## 症状
双击 `D:\g\fullscene-ocr-translator\target\debug\fs-gui.exe`，主窗口显示
「嗯… 无法访问此页面 / localhost 拒绝连接 / 请尝试：检查连接、检查代理和防火墙 / ERR_CONNECTION_REFUSED」。

## 根因
Tauri 2 根据 **feature 开关**决定加载内置静态资源还是外部 dev server：

| 构建产物 | 是否启用 `custom-protocol` | 运行时加载 |
|---|---|---|
| `target/debug/fs-gui.exe`（`cargo build` / `cargo run`） | **否**（默认） | 回退 `build.devUrl` = `http://localhost:1420` |
| `tauri build --features custom-protocol`（生产包） | 是 | 内嵌 `shared-ui/dist`（`tauri://localhost` 自定义协议） |

- `crates/gui/tauri.conf.json`：
  ```json
  "build": {
    "frontendDist": "../../shared-ui/dist",
    "devUrl": "http://localhost:1420"
  }
  ```
- `crates/gui/Cargo.toml`：`custom-protocol = ["tauri/custom-protocol"]` 是**可选 feature**。
- `crates/gui/package.json`：生产构建脚本是 `tauri build --features custom-protocol`。

所以双击 `target/debug/fs-gui.exe` 时，Tauri 去找 `localhost:1420` 的 dev server。
dev server 没在跑 → WebView2 报 `ERR_CONNECTION_REFUSED`。
之前能用是因为同时开着 `pnpm --filter shared-ui dev`（1420 端口服务）或 `scripts/dev.sh`。

## 修复
在 `crates/gui/Cargo.toml` 的 `[features]` 里给 `default` 加 `custom-protocol`，
使 **debug 构建也加载内置资源**：

```toml
[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```

重新构建后，`target/debug/fs-gui.exe` 直接加载 `shared-ui/dist`，不再依赖 1420 端口。

## 影响
- `cargo build -p fs-gui` 产出的 exe 可脱离 dev server 独立运行（适合真机自测/演示）。
- 若以后需要热更新前端（`tauri dev`），仍走 `pnpm --filter shared-ui dev` + `tauri dev`，
  dev 模式由 `tauri dev` 注入环境变量，不受 `default` feature 影响。