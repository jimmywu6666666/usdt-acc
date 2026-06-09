# 正式环境

- 地址：`https://acc.ziheexin.net`
- 应用目录：`/opt/usdt-ledger`
- 服务：`usdt-ledger.service`
- 数据库：PostgreSQL 14，仅监听服务器本机
- 反向代理：Nginx
- HTTPS：Let's Encrypt 自动续期
- 附件目录：`/var/lib/usdt-ledger/attachments`，不经过静态文件服务
- 数据库和附件备份：每 6 小时一次，保留 14 天

## 数据库隧道

启动：

```bash
./scripts/db-tunnel.sh
```

数据库客户端读取 `.env.remote` 中的 `DATABASE_URL`，或使用：

- 主机：`127.0.0.1`
- 端口：`55432`
- 数据库：`usdt_ledger`
- 用户：`usdt_ledger_dev`
- 密码：见 `.env.remote`

不要直接对公网开放 PostgreSQL `5432`。

## 服务管理

```bash
ssh -p 22022 -i ~/.ssh/usdt_ledger_prod -o IdentitiesOnly=yes root@acc.ziheexin.net
systemctl status usdt-ledger
journalctl -u usdt-ledger -f
systemctl restart usdt-ledger
```

## 备份

```bash
systemctl status usdt-ledger-backup.timer
ls -lh /var/lib/usdt-ledger/backups
```

备份目录中同时包含 PostgreSQL 的 `.dump` 文件和私有附件的 `.tar.gz` 文件。
每组备份还有一个 `.sha256` 校验清单，恢复前应先执行：

```bash
cd /var/lib/usdt-ledger/backups
sha256sum -c usdt_ledger-YYYYMMDDTHHMMSSZ.sha256
```

恢复演练必须使用临时数据库和临时附件目录，不得直接覆盖正式数据：

```bash
sudo -u postgres createdb -T template0 usdt_ledger_restore_test
install -o postgres -g postgres -m 600 usdt_ledger-时间.dump /tmp/restore.dump
sudo -u postgres pg_restore --no-owner --no-privileges \
  --dbname=usdt_ledger_restore_test /tmp/restore.dump
mkdir -m 700 /tmp/usdt-ledger-attachments-restore
tar -xzf usdt_ledger-attachments-时间.tar.gz \
  -C /tmp/usdt-ledger-attachments-restore
```
