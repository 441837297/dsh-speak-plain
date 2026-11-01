# 验证记录

验证日期：2026-11-01。当前版本：0.2.1。

## 自动检查

Node 内置测试运行器执行 27 项测试，全部通过。覆盖自动润色、最终回答筛选、设置保存、超时取消、并发隔离、原文保留和保护标记；真实 GenUI 卡片渲染、按钮动作归属会话、panel 去重、错误 JSON 回退、混合 Markdown、CRLF；以及“原回答默认折叠、可展开/收起、卸载恢复”等回归场景。

前端测试执行发布的 `lib/client.js`，其中包含真实的 `@changfenhuang/dsh-genui/embed` 组件与 CSS Modules。仅 DSH 基础 Markdown/代码控件使用替身，GenUI 卡片和按钮不再使用普通文本替身。构建检查确认样式占位符已经替换为组件 CSS。

宿主仍使用标准 ESM，浏览器仍遵循 DSH ModuleLoader 格式，共享宿主 React，不修改 DSH 核心或 GenUI 插件安装文件。

## 真实 DSH 回合检查

使用本机安装的真实 DSH CLI，将安装包加入项目下独立 DSH_HOME 的 headless profile，再注册确定性的本地测试主模型和编辑模型。原回答同时包含普通说明、代码块和 GenUI 围栏。编辑模型只收到保护后的正文，返回白话结果。

独立检查 storage-domain 里的 ready 结果与实际多帧 Zstandard 会话日志，确认主模型原文未被替换、代码和 GenUI 围栏保留、turn/end 正常 completed。主回答与编辑调用分别统计，DSH 自带标题生成请求单独统计。

上述测试不连接外部模型服务，不读取真实凭据，也不消耗用户额度。

## 已知验证范围

没有在用户正在使用的 GUI 中做点击/截图验收。组件渲染和交互通过真实 GenUI 组件的 React/Happy DOM 测试验证；完整视觉样式、大型图表、Mermaid、3D 资源和文件导航仍需实际界面检查。

`panel:true` 围栏有意不在润色区再次发布，避免重复 append；原会话面板继续承担显示。原组件与润色副本的本地交互状态分开保存。

0.2.1 保持原 storage-domain 名称、版本和设置结构。更新已安装包时，不清空用户选择的模型、启用开关、提示词或历史结果。当前运行进程不会被强制重启，用户需要重启 DSH 加载新代码。

## 复现

```sh
pnpm install
pnpm test
pnpm pack --pack-destination artifacts
```

真实回合验证脚本在源码的 scripts 目录，不随用户安装包分发。Windows PowerShell 示例：

```powershell
$env:DSH_SMOKE_APP = '<DeepSeek Harness 安装目录>\DeepSeek Harness.exe'
node scripts/runtime-cli.mjs plugin --profile headless add -w "$PWD/artifacts/dsh-speak-plain-0.2.1.tgz"
node scripts/runtime-cli.mjs --profile headless --patch scripts/smoke.patch.yml '验证润色功能，不执行任何工具。'
node scripts/verify-runtime.mjs
```

运行器固定使用独立的 `.smoke/clean-home`，不加载日常 profile。日志解压检查需要 Node.js 24 的 Zstandard API；插件本体支持 Node.js 22.19+。成功时输出 `REAL_DSH_RUNTIME_PASS`。
