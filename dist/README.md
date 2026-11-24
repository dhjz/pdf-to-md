# dist

本目录的两个压缩产物是**提交入库**的交付物，故意不被 `.gitignore` 忽略：

- `pdftomd.esm.min.js` — ESM，供 Node / 打包器 `import`。
- `pdftomd.umd.min.js` — UMD/IIFE，暴露全局 `PdfToMd`，供浏览器 `<script>` 直引。

由 `npm run build`（`esbuild`）从 `../src/` 生成。只打包 pdftomd 自身逻辑，
pdf.js 不内嵌：ESM 版保持 `pdfjs-dist` 为 external import，UMD 版从全局
`pdfjsLib` 读取。请勿手工编辑这两个文件，改源码后重新构建。
