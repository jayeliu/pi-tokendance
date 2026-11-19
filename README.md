# pi-tokendance

将 [TokenDance](https://tokendance.space/docs/ai-integration.md) 接入 pi 的扩展，使用 **OAuth 授权码（PKCE / S256）** 鉴权，默认走 **OpenAI Responses** 协议（`/gateway/v1/responses`）。

- Provider id：`tokendance`
- Base URL：`https://tokendance.space/gateway/v1`
- 协议：`openai-responses`（复用 pi 内置实现，无自定义流代码）
- 模型：内置一份支持 `openai:responses` 的目录快照（27 个），并在运行时从 TokenDance 公共目录刷新（刷新失败或离线时继续使用快照）

## 安装

从 npm 安装：

```bash
pi install npm:pi-tokendance
```

本地路径安装（不会复制文件，按绝对路径加载）：

```bash
pi install ./pi-tokendance
# 或仅本次试用：
pi -e ./pi-tokendance
```

安装位置：默认写入 `~/.pi/agent/settings.json`；加 `-l/--local` 写入当前项目的 `.pi/settings.json`。

## 登录

### 方式一：OAuth（推荐）

在 pi 里执行：

```
/login tokendance
```

1. pi 会打开 TokenDance 授权页（Headless 模式，`app_url` + `key_name` + S256 challenge，不含 `callback_url`）。
2. 用 TokenDance 账号登录并确认 Key 的名称、额度周期、可选过期时间与 RPM。
3. 页面显示一个 **10 分钟内有效的一次性授权码**，复制并粘贴回 pi。
4. 扩展用 `code` + `code_verifier` 调用 `POST https://tokendance.space/portal/api/v1/auth/keys`，换回一个新 Key，并存入 `~/.pi/agent/auth.json`。

也可以直接用命令行登录（等价）：

```bash
pi auth login tokendance --no-browser
```

> TokenDance 的 Key **只在交换成功的首次响应里出现**，且平台不提供 refresh token。因此扩展把凭据视为长期有效、不做刷新；如果 Key 被禁用/删除，请重新 `/login tokendance`。

### 方式二：环境变量 / 手动 API Key

```bash
export TOKENDANCE_API_KEY=sk-...
```

或在 `/login tokendance` 时选择保存 API Key（`pi auth login tokendance --api-key`）。

优先级：`TOKENDANCE_API_KEY`（环境变量）> 已保存的 OAuth/API Key 凭据 > `models.json` 中的 Key。
注意：本扩展注册的 `apiKey` 会**覆盖** `~/.pi/agent/models.json` 里同名 provider 的 `apiKey`，所以加载扩展后需要 `/login` 或设置环境变量。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TOKENDANCE_API_KEY` | — | API Key 回退（OAuth 未使用时生效） |
| `TOKENDANCE_APP_URL` | `app://pi-tokendance` | 应用归因 App URL。写入 OAuth Key 的 `app_url`，并作为每次请求的 `X-App-URL` 头 |
| `TOKENDANCE_KEY_NAME` | `pi-tokendance` | 授权页上显示的 Key 名称 |

## 使用

```bash
# 查看可用模型
pi --list-models tokendance

# 指定模型
pi --model tokendance/kimi-k3 "你好"

# 思考等级（网关对 none/minimal/low/high/xhigh 均接受）
pi --model tokendance/deepseek-v4-pro-0813:high "解释一下这段代码"
```

代码中：

```ts
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
// provider id "tokendance"，协议 openai-responses
```

## 模型元数据说明

TokenDance 目录只提供 `id / name / description / context_length / supported_protocols`，没有 reasoning / vision 字段。扩展的处理：

- `reasoning: true`（网关接受 `reasoning.effort` 与 `include: ["reasoning.encrypted_content"]`）；
- `input` 通过描述里的关键词（视觉 / 多模态 / 图片 / 图像 / 视频 / vision / multimodal）推断是否支持图片，其余为纯文本；
- `cost` 全部为 0（TokenDance 未提供价格信息）；
- `contextWindow` 取目录的 `context_length`，`maxTokens` 取 32K 与上下文窗口的较小值。

如需覆盖模型元数据，可修改本扩展的 `SEED_MODELS` / `toModelConfig`。注意：一旦扩展注册了 `models`，该 provider 的模型列表就**以扩展为准**——`~/.pi/agent/models.json` 里 `tokendance` 下的模型定义会被替换（`apiKey` 也会被扩展的 `$TOKENDANCE_API_KEY` 覆盖）。

## 恢复提示

TokenDance 在需要干预时返回响应头 `TokenDance-Recovery-Action`：

- `top_up_balance`：余额不足，充值即可（Key 仍有效）；
- `reauthorize_api_key`：Key 无效 / 被禁用 / 已过期，需重新 `/login tokendance`；
- `api_key_quota`：达到日/周/月额度，等待刷新或重新授权。

## 测试

```bash
node test.ts    # 需要 Node >= 22.6（会联网校验实时目录）
```

覆盖：provider 注册结构、PKCE（长度/字符集/随机性/S256 关系）、授权码解析，以及实时目录发现与内置快照的一致性（id / input / contextWindow 完全匹配）。

实时目录检查默认只告警（离线时不阻断）；设置 `TD_REQUIRE_NETWORK=1` 可让网络检查失败时返回非零退出码：

```bash
TD_REQUIRE_NETWORK=1 node test.ts
```

## 发布（维护者）

推送到 `v*` tag 会触发 `.github/workflows/publish.yml`：校验 tag 与 `package.json` 版本一致 → 跑测试 → `npm publish --access public`。

发布使用 **npm trusted publishing（OIDC）**，不需要任何长期 token：workflow 里的 `id-token: write` 让 npm CLI 把 GitHub OIDC token 换成短期的 publish token（provenance 会自动生成）。

一次性配置（在 npmjs.com 上，包管理页面）：

1. 打开 `https://www.npmjs.com/package/pi-tokendance/access` → **Trusted Publisher** → **GitHub Actions**。
2. 填写：Organization or user `jayeliu`、Repository `pi-tokendance`、Workflow filename `publish.yml`、Environment 留空。
3. **勾选 “Allow npm publish”**（`npm stage publish` 默认允许，但直接 `npm publish` 必须显式勾选）。
4. 首次发布必须在配置后 **2 天内**完成，否则该配置会过期。

发版：

```bash
npm version patch        # 或 minor / major，会自动提交并打 tag
git push --follow-tags
```

可选加固：把包页面 Settings → Publishing access 设为 “Require two-factor authentication and disallow tokens”，并删除不再需要的 `NPM_TOKEN` secret。

## 文件

- `index.ts` — 扩展实现（provider 注册 + OAuth login + 目录发现）
- `test.ts` — 自检脚本（`npm test`）
- `package.json` — pi 包清单（`pi.extensions`、`peerDependencies`）
- `.github/workflows/publish.yml` — tag 触发的 npm 发布工作流
