# 单用户 Bearer 鉴权（#20 拆分 1/2）

## 配置与升级

生成随机 Token：`openssl rand -hex 32`。将其保存到私有 `.env` 的 `MNEMIC_AUTH_TOKEN`，
服务端通过环境变量读取，重启后生效；不要提交 `.env` 或把 Token 放进 URL、Issue、截图。
允许 32–256 位 Bearer 协议 ASCII 字符，空值、空白和旧示例 `change-me` 均拒绝启动，
错误提示不回显原值。启动先校验 Token，再初始化数据库/监听端口。

升级旧版本时须先配置新 Token，再启动服务；否则业务请求返回 401 或启动被拒绝。
令牌轮换：更新服务端环境并重启，再更新 CLI/Web 输入。当前不支持多个并行 Token 或热轮换。
回退到旧版本会恢复无鉴权接口，不能在公网原地降级；应先限制网络入口。

## CLI

CLI 不自动加载 `.env`。在本地可信 shell 中输入与服务端一致的 Token（不回显），然后导出：

```bash
read -r -s MNEMIC_AUTH_TOKEN
export MNEMIC_AUTH_TOKEN
pnpm cli doctor --server http://127.0.0.1:3000
```

`authentication: OK` 表示当前请求通过鉴权，其他检查仍独立报告（例如模型未 probe 仍为 SKIP）。
缺失/错误 Token 返回 401，CLI 退出 1 并给出安全提示，不自动重试。chat、memory 同样携带 Bearer。
只读 doctor 不调用外部模型；`doctor --probe` 和 chat 可能计费。

## Web

连接项目时同时输入项目 UUID 和服务端 Token。Token 是密码输入框，只在当前页面的 client 闭包中保留，
不写 localStorage/sessionStorage，不编入 Vite 产物；项目 UUID 仍可保留用于下次预填。
刷新或“更换”会要求重新输入 Token。错误 Token 会在业务页面显示 401，可点“更换”重新输入。
`VITE_API_BASE_URL` 仅配置服务地址，不能在任何 `VITE_*` 变量里填写 Token。

跨源开发需让 `CORS_ORIGIN` 精确等于 Web 源（含协议、主机、端口，默认 `http://localhost:5173`）。
配置源的 OPTIONS 预检不带 Token，只返回 CORS 协议响应，不执行业务逻辑；真实请求仍必须鉴权。
普通 OPTIONS 和其他源的未认证预检返回 401。CORS 不替代鉴权。

## 接口与安全边界

- 仅 `GET/HEAD /health` 公开用于存活检查。所有业务接口、未知路由和模型探测均先鉴权，
  包括读取记忆、修正、软删除、Providers 管理、对话和 doctor。没有按项目 UUID 推断用户权限。
- 认证失败统一 `401 application/problem+json`，`code: UNAUTHORIZED`、请求 ID、
  `WWW-Authenticate: Bearer realm="mnemic"`、`Cache-Control: no-store`。不接受 cookie/query/x-api-key 代替 Bearer。
- Token 摘要用 SHA-256 和 `timingSafeEqual` 比较，不存数据库。授权头、cookie、x-api-key 日志脱敏，
  请求日志不记录查询参数，404 不回显查询参数。不要在模型正文、路径、标题等普通内容字段粘贴凭据；
  本次不承诺自动识别任意位置的所有密钥。
- 这是单用户门禁：持有 Token 即能操作服务端全部项目与模型配置；不是多租户、RBAC 或按项目授权。
  Token 只应发给服务所有者。主密钥 `MNEMIC_MASTER_KEY` 与 API Token 是两个不同用途的密钥。
- `buildApp` 是依赖注入工厂；测试夹具可不注入 Token。任何自定义嵌入入口必须显式注入有效 `authToken`；
  正式启动入口 `src/index.ts` 始终要求环境 Token，无可选关闭开关。
- Bearer 不提供传输加密。默认仍只监听 `127.0.0.1`；本 PR 未交付 Caddy、HTTPS、全栈 Compose、
  自动续证或干净 VPS 验证（#20 拆分 2/2）。本地 HTTP 仅供环回调试，不能据此认为已可公网部署。

## 验证与未交付项

自动测试覆盖缺失/错误/畸形 Token、业务与解析前拒绝、健康检查边界、CORS 预检、
成功/失败日志脱敏、启动拒绝和 Web 刷新/更换时重新输入 Token。
VPS 和真实证书续期没有在本 PR 验证；#20 保持打开。限流、配额及暴力尝试治理归 #23。
