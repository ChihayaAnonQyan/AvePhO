# AvePhO 管理后台

唯一管理员使用密码登录，可管理公告和发布试卷。官网由 GitHub Pages 提供，访客可以直接浏览并下载。

## 已有公告后台的升级步骤

1. 将这次更新作为 PR 合入 GitHub 仓库的 `main` 分支。拉取最新代码到本机。
2. 在 GitHub App **AvePhO Publisher → Permissions & events → Repository permissions**，将 **Contents** 设为 **Read and write**，保留 **Actions: Read and write**。保存后，在 App 的安装页面接受新权限，并确认安装范围仍是 AvePhO 仓库。发布试卷时，App 需要能够更新 `main` 分支。
3. 把原来部署用的 `wrangler.jsonc` 复制到更新后的 `admin-worker` 目录，保持其为本地文件。在该目录运行 `npx wrangler deploy`。沿用已配置的密码、环境变量、密钥与 D1 数据库，这次升级没有新的数据库迁移。

## 发布一届试卷

1. 登录后台，点「试卷管理 → 新增届次」。填写届数、实际举办年份和试题版本，选择试题 PDF。答案与评分标准 PDF 可以稍后补传。每份 PDF 上限为 10 MiB。
2. 点「发布到官网」并确认。后台把 PDF 原件和试卷目录写入 GitHub，并启动 GitHub Pages 工作流。部署完成后，点「核对官网」，在「历届试题」打开该届页面检查下载。
3. 要补传答案，打开已登记的届次，选择答案 PDF、填写版本，然后再次发布。已提供的资料会一起生成可下载的 ZIP。若文件已经存入 GitHub、部署启动失败，可点「重试部署」。

## 配置顺序

如果解压后已有 `wrangler.jsonc`，说明本包已预填 AvePhO 的地址和编号。可以直接从第 3 步开始。Windows 上打开 `admin-worker` 文件夹，在资源管理器地址栏输入 `cmd` 并回车，就能在该文件夹运行下列命令。

1. 在 Cloudflare 建立免费 D1 数据库 `avepho-admin`，在该账号的 Workers & Pages 中确定后台的 `workers.dev` 地址。复制 `wrangler.example.jsonc` 为 `wrangler.jsonc`。每个 `REPLACE` 都须替换，后台地址保留 `https://`，末尾去掉斜杠。
2. 创建仅自己账号可安装的 GitHub App，用来写入试卷和启动自动部署。主页填官网，回调地址留空，关闭 Webhook。仓库权限选 **Contents: Read and write** 和 **Actions: Read and write**，保留 GitHub 自动设定的 **Metadata: Read-only**。把 App 仅安装到 `ChihayaAnonQyan/AvePhO`，填入其 Client ID 和 Installation ID。
3. 在 `admin-worker` 目录用 Node.js 生成管理员密码和对应的校验值。把第一项存入自己的密码管理器，第二项用于 Cloudflare 设置。

       node generate-password.mjs

4. 在 `admin-worker` 目录应用数据库迁移并部署 Worker。请使用 Wrangler 4.36.0 或更新版本，以支持登录限速绑定。若已有旧版后台，数据库迁移会结束旧登录会话，公告草稿和发布记录会保留。

       npx wrangler login
       npx wrangler d1 migrations apply avepho-admin --remote
       npx wrangler deploy

   打开 Worker 的 **Settings → Variables and Secrets**，用 **Secret** 类型设置以下三项。

   | 名称 | 值 |
   |---|---|
   | `ADMIN_PASSWORD_SHA256` | 生成器输出的密码校验值 |
   | `GITHUB_PRIVATE_KEY` | GitHub App 生成的完整 PEM，包括起止行 |
   | `EXPORT_SECRET` | 另行生成的随机值，建议至少 32 字节 |

   生成 `EXPORT_SECRET` 可在本机运行以下命令。它与管理员登录密码是两项独立的值。

       node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"

   后台登录页填写第 3 步生成的密码。以后需要换密码时，重新生成一组并更新 `ADMIN_PASSWORD_SHA256`，已有会话随即失效。

5. 在 GitHub 仓库 **Settings → Secrets and variables → Actions**，创建 Repository variable `ANNOUNCEMENTS_ADMIN_URL`，值为后台地址。再创建 Repository secret `ANNOUNCEMENTS_EXPORT_SECRET`，值与第 4 步的 `EXPORT_SECRET` 相同。上述私钥和密钥只在对应平台的安全设置中保存。
6. 将此版合入 `main` 后，在 Actions 手动运行 `Build and deploy AvePhO`，为官网加上页脚后台入口。运行成功后用未登录的浏览器打开首页、公告页、搜索和试题下载，再从页脚进入后台登录。

## 发一条公告

填写标题和正文，点「预览」检查排版，点「保存草稿」保存。确认内容后点「发布」。等 GitHub 工作流成功，再点「核对官网」确认。想撤回时选中对应公告，点「撤回」，等部署并再次核对。公告从官网正文、列表及搜索中移除。历史首届两篇公告由原有静态来源保留。

网络或部署失败时可通过 GitHub Actions 查看日志。修正后点「重试部署」，系统会继续同一份已保存的发布内容。后台一次处理一项待上线更新，确认发布结果后才能接受下一项发布或撤回。

## 本地验证

在仓库根目录运行 `node admin-worker/verify.mjs`，需要 Node.js 24 和 Python 3。测试覆盖公告的发布与撤回、试卷上传权限、并发更新冲突、发布重试、补传答案和四语归档。测试使用 SQLite 和模拟的 GitHub、GitHub Pages 响应。生产环境验收需要用部署后的 Worker 核对登录和实际发布。

## 参考

- [Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Workers 登录限速绑定](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [GitHub 工作流 REST 接口](https://docs.github.com/en/rest/actions/workflows)
- [Cloudflare D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)
