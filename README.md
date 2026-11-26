# AvePhO 公开站首版

解压后用浏览器打开顶层 index.html。也可在本目录运行 python3 -m http.server 8000，再访问 http://localhost:8000/ 。各语言的页面和搜索索引均已生成，静态文件支持 GitHub Pages 项目子路径。

## 内容维护

src/originals.json 保存组织者提供的简中原文，src/labels.tsv 保存四语界面及编辑译文，src/build.py 生成页面。修改文本后运行以下命令。

    python3 src/build.py
    python3 src/verify.py

resources 保存首届试题原件、含评分标准的答案 ver1.2 和整届 ZIP。7 月 4 日公告保留当时公布的 ver1.1 文件名。网站语言按钮会保留当前栏目，主题和语言偏好保存在浏览器本地。

## 首版范围

已提供公开内容、四语导航、十栏目、单篇公告、试题详情、离线关键词搜索与双主题。源资料的中文原文保留在各语种页面。首页使用组织者提供的 Logo。组委会页目前列出组织者确认的首届命题人。

后续开发包括私有后台、身份认证、审核和定时发布、匿名统计、媒体管理、轮播和日期彩蛋。看板娘公开使用范围和音乐素材待补。正式发布前还需全量验收和部署配置。

## GitHub Pages 部署

1. 在现有仓库的 `main` 分支提交解压得到的文件，保留根目录下的 `.github/workflows/pages.yml`。
2. 在仓库的 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
3. 打开 **Actions → Build and deploy AvePhO → Run workflow**，选择 `main` 并运行。部署成功后，`github-pages` 环境会显示站点地址。

发起指向 `main` 的拉取请求时会执行构建检查。公开发布由 `main` 分支上的手动工作流触发。构建产物只包含生成的页面、公开资源和下载文件。

在本地复现部署构建时，可选择新的空目录作为输出。

    python3 src/build.py --output dist
    python3 src/verify.py --output dist

## 管理后台

发布工作流从 Worker 读取已确认的公告，并使用 `src/papers.json` 和 `resources/editions/` 生成后续届次。使用 [后台部署说明](admin-worker/README.md) 完成首次配置或从公告后台升级。
