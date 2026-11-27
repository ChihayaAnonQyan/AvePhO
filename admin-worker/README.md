# AvePhO 管理后台

管理员使用密码登录。左侧可发布试卷、通告和文章，也可管理组委会名单。官网由 GitHub Pages 提供，定时公开的文件由现有 Worker 和 D1 提供下载。

## 从旧版升级

将更新合并到 `main` 并拉取到本机。在保留原 `wrangler.jsonc` 的 `admin-worker` 目录依次运行以下两条命令。

    npx wrangler d1 migrations apply avepho-admin --remote --config wrangler.jsonc
    npx wrangler deploy --config wrangler.jsonc

迁移 `0005_committee.sql` 使用现有 `avepho-admin` 数据库，沿用现有 GitHub App、管理员密码和密钥。Worker 部署成功后，在 GitHub 的 Actions 中对 `main` 运行一次 **Build and deploy AvePhO**，升级访客端「组委会」页面。

## 公开届次、试题和答案

1. 在「发布试卷」点「新增届次」，填写届数与年份。试题和答案分别选择「随届次公开」或「定时公开」。时间按北京时间（UTC+08:00）填写，每份 PDF 上限为 10 MiB。
2. 点「保存草稿」可提前上传文件。准备向访客公布届次时，点「公开届次」。GitHub Actions 部署完成后，首页显示最新的公开届次，赛事日程提前列出试题和答案的公开时间。
3. 已随届次发布的定时文件，到点即可下载。Worker 在下载请求到达时检查时间，文件开放时无需再部署。仅填写时间也可以公布日程。补传之后，保存草稿并点击「发布更新」，再确认官网部署完成。

## 发布文章

在「发布文章」填写标题和正文。公式可写成 `$…$` 或用独占一行的 `$$` 包住多行公式。选择图片会在当前光标位置加入图片，PDF 会列在文章底部。预览并保存草稿后，点击「公开文章」。需要撤回时，在文章列表打开该篇文章并点击「撤回文章」。

## 管理组委会

「组委会管理」包含每届命题组和命题委员会。首次打开会载入原有首届命题人。新增届次时，每行填写一位命题人。添加委员时填写昵称和简介，公开后按昵称拼音或英文字母排列。

修改后点「保存草稿」，准备公示时点「发布更新」。等 GitHub Actions 运行完成，再点「核对官网」。如果自动部署未触发，可通过「查看部署记录」在 `main` 手动运行 **Build and deploy AvePhO**。

## 配置顺序

以下步骤用于首次配置。Windows 上打开 `admin-worker` 文件夹，在资源管理器地址栏输入 `cmd` 并回车，就能在该文件夹运行下列命令。

1. 在 Cloudflare 建立免费 D1 数据库 `avepho-admin`，在该账号的 Workers & Pages 中确定后台的 `workers.dev` 地址。复制 `wrangler.example.jsonc` 为 `wrangler.jsonc`。每个 `REPLACE` 都须替换，后台地址保留 `https://`，末尾去掉斜杠。
2. 创建仅自己账号可安装的 GitHub App，用来启动自动部署。主页填官网，回调地址留空，关闭 Webhook。配置 **Actions: Read and write**，保留 GitHub 自动设定的 **Metadata: Read-only**。把 App 仅安装到 `ChihayaAnonQyan/AvePhO`，填入其 Client ID 和 Installation ID。
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

在「发布通告」填写标题和正文，正文支持 Markdown 和 LaTeX。点「预览」检查排版，再点「保存草稿」和「发布」。等 GitHub 工作流成功，再点「核对官网」确认。撤回时选中对应公告，点「撤回」，等部署并再次核对。历史首届两篇公告由原有静态来源保留。

网络或部署失败时可通过 GitHub Actions 查看日志。修正后点「重试部署」，系统会继续同一份已保存的发布内容。后台一次处理一项待上线更新，确认发布结果后才能接受下一项发布或撤回。

## 本地验证

在仓库根目录运行 `node admin-worker/verify.mjs`，需要 Node.js 24 和 Python 3。测试覆盖草稿保密、试题和答案的公开边界、文章撤回、部署重试和四语页面。测试使用 SQLite 和模拟的 GitHub、GitHub Pages 响应。

## 参考

- [Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Workers 登录限速绑定](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [GitHub 工作流 REST 接口](https://docs.github.com/en/rest/actions/workflows)
- [Cloudflare D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)
