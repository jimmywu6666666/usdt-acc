# USDT 财务记账系统

多租户团队 TRC20 USDT 链上流水、业务批注、主管审核和历史追溯系统。

## 使用说明

- [主管和员工使用说明](docs/主管员工使用说明.md)
- [项目开发维护日志](docs/项目开发维护日志.md)
- [正式环境部署说明](DEPLOYMENT.md)

## 核心规则

- 链上交易是金额、钱包、方向、时间和交易哈希的唯一数据来源。
- 员工不能手工填写金额或选择钱包，只能选择已同步的链上流水。
- 员工为流水选择收支分类，填写客户信息、业务说明或资金用途，并可选择或粘贴凭证图片。
- 凭证图片会自动纠正方向、限制最长边为 1920px 并转为 WebP 压缩，单张图片上限 10MB。
- 凭证图片存放在私有目录，数据库只保存文件元数据；下载前校验租户和员工查看权限，并写入操作日志。
- 每一条新批注、驳回重提、修正和冲正都必须由本系统主管审核。
- 批注详情显示批注人、审核人、版本号、驳回原因、凭证和完整操作日志。
- 不再使用精确匹配、疑似匹配、未匹配、匹配时间窗口或未匹配删除规则。
- 链上流水永久保留，不能因为没有批注而删除。
- 每个钱包设置“纳入管理起始时间”；起始时间之前的流水可查询但默认无需批注，也不进入待办和现金流统计。
- 主管可以修改钱包纳入管理时间，或主动对某条历史流水发起补批注，所有操作均记录日志。
- 同一系统内两个受管钱包之间、交易哈希和金额一致的收付流水会自动合并为一笔“内部划转”。
- 内部划转的两侧链上记录永久保留，但共用一份批注和审核结果，且不计入进账、出账统计。
- 仅同步到内部划转一侧时显示“内部划转待确认”，待另一侧同步后自动转为可批注状态。

## 状态和版本

- `待批注`：链上已有流水，但尚未补充业务信息。
- `待审核`：员工已提交批注，等待主管确认业务原由、凭证和金额是否符合实际业务。
- `已通过`：主管已确认批注，可计入业务收支统计。
- `已驳回`：主管填写原因后退回；原版本保留，员工可修改并生成新版本重新提交。
- `已被修正`：新的修正版本通过后，原批准版本停止生效并保留历史。
- `已被冲正`：冲正版本通过后，该链上流水仍存在，但不再计入业务收支统计。

修正版本等待审核期间，原批准版本继续有效。修正或冲正只有主管审核通过后才生效。

## 技术方案

- 前端：原生 HTML、CSS、JavaScript。
- 后端：Node.js 原生 HTTP 服务。
- 数据库：PostgreSQL；未配置时使用本地 JSON 文件。
- 链上接口：TronGrid 或兼容 TRON 节点。
- Redis：第一版不使用。

## 运行

```bash
node server/index.mjs
```

打开 `http://localhost:5173`。演示账号默认密码为 `123456`。

配置 PostgreSQL 和 TRON：

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/usdt_ledger
PORT=5173
HOST=127.0.0.1
TRON_PROVIDER=auto
TRON_API_BASE_URL=https://api.trongrid.io
TRON_API_KEY=你的_TRONGrid_API_Key
TRON_USDT_CONTRACT=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
TRON_INITIAL_SYNC_DAYS=30
TRON_SYNC_OVERLAP_MINUTES=10
CHAIN_SYNC_INTERVAL_MINUTES=5
ATTACHMENT_DIR=data/attachments
```

```bash
npm install
npm run db:migrate
npm run db:import-state
npm run dev
```

未配置 `TRON_API_KEY` 时，系统会禁用链上同步并显示配置提示，不会向正式台账写入模拟流水。首次同步默认读取最近 30 天，后续同步从最新流水前 10 分钟开始重叠查询，并按钱包、交易哈希和事件序号去重。配置完成后服务启动即执行一次同步，之后默认每 5 分钟自动同步；单钱包请求会对限流及临时服务错误重试 3 次，一个钱包失败不会阻断其他钱包。最终失败会写入钱包状态和操作日志，并在总览显示异常提示。钱包首页显示的是 TRON 接口返回的当前 USDT 余额。

## 主要 API

- `POST /api/chain/sync`：同步启用钱包的 TRC20 USDT 流水。
- `POST /api/chain/search`：按交易哈希或钱包地址查询。
- `POST /api/annotations`：为链上流水提交新批注。
- `POST /api/annotations/:id/resubmit`：修改已驳回批注并生成新版本。
- `POST /api/annotations/:id/review`：主管通过或驳回批注。
- `POST /api/annotations/:id/correct`：提交修正版本。
- `POST /api/annotations/:id/reverse`：提交冲正版本。
- `GET /api/chain-transactions/:id/detail`：读取链上流水、全部批注版本和操作日志。
- `GET /api/annotations/:id/attachment`：校验权限并下载批注附件。
- `POST /api/exports/annotations`：按筛选条件导出链上流水及批注 CSV。

## 数据迁移

旧版中已经关联链上交易的账目会自动转换为批注版本。没有链上交易来源的旧手工账目会转存到 `legacyEntries`，仅用于历史审计，不再参与新系统统计。
