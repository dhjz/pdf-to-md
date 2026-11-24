# PDF → Markdown 转换器（静态页面）

纯静态单页应用，入口是 `index.html`，依赖每个一行从 CDN 引入，转换全程在浏览器本地完成，文件不上传。

## 功能

- 拖入 / 粘贴（Ctrl+V）/ 点击选择 PDF。
- 选项：在正文中包含图片（data:image base64 内联）、重建表格结构。
- 结果三个 Tab：HTML 预览（marked.js + DOMPurify）、原始 MD、JSON（含 markdown、markdownRaw、图片 base64、页面块、统计）。
- 一键「导出 MD + 图片 ZIP」：`.md` 在根、`images/` 子目录存原图，路径和 Markdown 占位符一致，解压后本地无缝打开。
- 转换会在浏览器控制台打印统计；整份 PDF 无文字层时打印具体原因。
- 顶部标题右侧展示转换内核版本号（`PdfToMd.version`）。
- 顶部统计：字符数、非空白字符数、大小、页数、文本项、表格数、图片数量、图片数据总大小、含图正文大小、转换耗时，以及复制/下载按钮。

## 依赖

第三方库各一行 `<script src>`；pdf.js 用一行 module import。不写加载器、不回退。

| 依赖 | 版本 | 来源 |
| --- | --- | --- |
| Vue 3 | 3.4.21 | `mirrors.sustech.edu.cn/cdnjs/ajax/libs/vue/3.4.21/vue.global.prod.js` |
| marked | 16.1.2 | `mirrors.sustech.edu.cn/cdnjs/ajax/libs/marked/16.1.2/lib/marked.umd.min.js` |
| DOMPurify | 3.1.6 | `mirrors.sustech.edu.cn/cdnjs/ajax/libs/dompurify/3.1.6/purify.min.js` |
| pdf.js | 4.10.38（与 `pdf-to-md` 一致） | `cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.mjs` + `pdf.worker.mjs`（ES module 入口） |
| 转换内核 | 本地产物 | `static/vendor/pdftomd.umd.min.js`（我们自己的构建，不走 CDN） |

pdf.js 保持项目既有内核 4.10.38，不为了加载方式换版本。4.x 在 cdnjs 提供 `.mjs`，用 `type="module"` 一行 `import` 即可；转换内核 UMD 仍由模块脚本动态引入，避免与 pdf.js 的加载顺序竞态。

## 使用

用本地静态服务器打开即可（内核 UMD 是本地文件，需同源）：

```bash
cd pdf-viewer
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

## 内核一致性

`static/vendor/pdftomd.umd.min.js` 由 `pdf-to-md/build.js` 从 `pdf-to-md/src/` 构建生成，是 UMD/IIFE 产物；网页版和 CLI 版共用同一套转换逻辑。

## 来源

- 转换内核：仓库 `../pdf-to-md`（Issue #1 / PR #3），UMD 产物见 `pdf-to-md/dist/`
- Vue 3、marked、DOMPurify、pdf.js 版本与许可证见社区对应项目；pdf.js 许可证见 `static/vendor/PDFJS-LICENSE.txt`
