# 批量任务中心实施与验收

桌面批量窗口支持一次处理 100 条链接。Chrome、Edge 和 Firefox 可以把 100 条资源及其类型和请求头一键交接到桌面草稿。用户确认后，窗口逐条显示入队结果。已入队的任务保留原有 ID，失败项可以独立修正重试。

## 实施

1. 记录旧扩展短批次和长批次的协议长度及实际唤起表现。
2. 沿用现有批量窗口和三路创建并发。显示待提交、无效、提交中、已入队和失败。允许继续提交待处理项和重试失败项。列表刷新错误独立于逐条结果。
3. 每行使用稳定的 UUID。桌面端串行处理同 UUID 的请求，已有任务直接返回结果。先保存详情和活动索引，再启动下载。
4. 小批次沿用旧协议。超过 1,800 字符时通过一次性密钥加密，并向本机回环端口 47873 交接。回执也经过认证。桌面等待 35 秒，扩展最多重试 25 秒，单批上限为 500 条和 2 MiB。干扰或超时后保留扩展选择。桌面草稿按到达顺序处理。
5. 补齐桌面十种语言和扩展中英文。草稿预览、单条下载和直播入口沿用原有流程。

## 验收

- 前端测试覆盖 100 条、部分成功、失败重试、重复提交、无效行和刷新异常。
- Rust 测试覆盖创建幂等、持久化故障，以及交接的认证、重放、限制和超时。
- Windows 的 Chrome、Edge、Firefox 均验证冷启动和运行中的 100 条交接。macOS、Linux 各验证一次安装包协议唤起和长批次。
- 用本地测试服务混合 HLS、DASH、直链和失败链接，检查草稿、入队 ID 和输出文件。
- 运行 lint、前端测试、前端构建，以及主程序与媒体测试服务的 Rust 测试。记录实际运行结果和未覆盖环境。

## 验证记录

| 检查 | 结果 |
| --- | --- |
| 协议长度 | 合成请求中，旧协议 2 条为 510 字符，100 条为 19,056 字符。新协议固定为 143 字符，资源列表通过本机通道交接。 |
| Node 24.22.2 | lint、32 项前端测试和生产构建通过。测试覆盖 Chromium 与 Firefox 扩展代码的旧协议、100 条交接、交接重试和超限处理。 |
| Windows Edge 界面 | 在真实 Edge 浏览器中使用模拟桌面桥接，验证草稿排队、100 条提交、无效行、列表刷新失败、重复点击和使用原 UUID 重试。另覆盖旧批量协议及单条下载、直播、预览入口。 |
| Windows WebView2、Chrome、Edge | 在 Chrome 和 Edge 的临时扩展后台分别通过 Rust 回环通道交接 100 条。隔离桌面进程收到草稿后，确认前任务数不变。每轮故意让一条 HLS 请求失败，修正后仅重试该行。每轮新增 100 个不同 ID，全部完成，并比对本机 HLS、DASH 和直链夹具的输出字节。 |
| Rust 桌面测试 | 144 项通过，覆盖并发重试幂等、初始索引写入失败、100 条 HTTP 交接、错误密钥、重放、超限、过期和端口冲突。 |
| 本地媒体测试服务 | `cargo test --locked --manifest-path test-hls-server/Cargo.toml` 通过 3 项测试。 |
| 发布环境待覆盖 | Firefox 实装与回环联调、三款浏览器的系统协议冷启动，以及 macOS、Linux 安装包烟测。本次桌面联调通过注入协议事件进入实际导入流程。混合批次使用合成媒体夹具，覆盖落盘和字节一致性。 |

浏览器界面测试先执行 `npm run build`，再运行 `node scripts/test-batch-task-ui.mjs <Playwright 的 index.mjs 路径>`。

Windows 上直接运行 Rust 测试二进制时，系统加载器需要 Common Controls v6 清单。本机使用 `cargo test --locked --release --manifest-path src-tauri/Cargo.toml --no-run` 编译后，将 `.tools/app.manifest` 附加到测试二进制副本，再执行该副本。原有的连接失败回归用例改用接受后立即关闭的回环连接，以稳定触发连接错误。

复跑 WebView2 联调时，保留独立应用标识符及空的协议列表，以隔离任务数据与系统协议关联。使用支持 WebView2 调试的 Windows 环境及已构建的前端资源。

~~~powershell
$env:TAURI_CONFIG = '{"identifier":"com.liubsyy.m3u8quicker.batchtest","app":{"withGlobalTauri":true},"plugins":{"deep-link":{"desktop":{"schemes":[]}}}}'
cargo build --locked --release --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol --target-dir .tools/batch-probe-target
Remove-Item Env:TAURI_CONFIG
$playwrightPath = 'C:/path/to/playwright/index.mjs'
node scripts/test-batch-task-native.mjs $playwrightPath .tools/batch-probe-target/release/m3u8quicker.exe chrome
node scripts/test-batch-task-native.mjs $playwrightPath .tools/batch-probe-target/release/m3u8quicker.exe msedge
~~~

若本机加载器要求 Common Controls v6，将同一清单附加到隔离桌面可执行文件的副本后运行。
