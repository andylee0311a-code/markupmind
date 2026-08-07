# MarkupMind

MarkupMind 是一個在瀏覽器中執行的 HTML 品質檢查 App，可檢查：

- HTML 文件結構與常見標籤錯誤
- 英文冠詞、主詞動詞一致與平行結構等常見問題
- 圖片替代文字、頁面語言與連結文字等無障礙問題

使用者可以貼上程式碼或上傳 `.html` 檔案。所有分析都在瀏覽器本機完成，不會上傳檔案內容。

## 本機執行

```bash
pnpm install
pnpm dev
```

## 建置

```bash
pnpm build
```

此專案使用 Next.js，可直接連接 GitHub repository 並部署至 Vercel。
