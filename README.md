# Video Downloader

Chrome 擴充功能（Manifest V3）：偵測網頁中播放的影片、音訊與 HLS 串流，一鍵下載。功能參考 Video DownloadHelper。

## 功能

- **自動偵測**：監看網路回應（`video/*`、`audio/*`、`.mp4`／`.webm`／`.m3u8` 等），並掃描頁面中的 `<video>`／`<audio>`。工具列徽章顯示偵測到的數量。
- **直接下載**：一般影音檔交給 Chrome 下載管理員，檔名取自分頁標題。
- **HLS 串流**：解析 master playlist 列出所有畫質，平行下載片段、支援 AES-128 解密與 byte-range，合併成單一 `.ts`（fMP4 串流則為 `.mp4`）。音訊獨立的串流會另存一個音訊檔。
- **Referer 處理**：下載時以 `declarativeNetRequest` 對需要的主機帶上原頁面的 Referer／Origin，避免 CDN 拒絕。
- 過濾串流片段（`.ts`、`.m4s`）與小於 512 KB 的檔案（多半是預覽或廣告）。

## 安裝

1. 開啟 `chrome://extensions`，打開右上角「開發人員模式」。
2. 按「載入未封裝項目」，選擇此資料夾。

## 限制

- 不支援 DRM／SAMPLE-AES 加密內容與直播串流。
- 不支援 DASH（`.mpd`）與以 MediaSource 播放的 `blob:` 影片（例如 YouTube）。
- HLS 合併在記憶體中進行，非常大的影片會佔用相當記憶體。
- 影像與音訊分開的串流會存成兩個檔案，需自行以 ffmpeg 等工具合併。

## 架構

| 檔案 | 角色 |
| --- | --- |
| `background.js` | Service worker：偵測媒體、每分頁清單（`storage.session`）、徽章、HLS 解析預覽、下載工作管理、Referer 規則 |
| `content.js` | 回報頁面中的 `<video>`／`<audio>` 來源 |
| `offscreen/` | 執行 HLS 下載：抓片段、解密、組成 Blob（service worker 無法建立 blob URL） |
| `popup/` | 彈出視窗：媒體清單、畫質選擇、下載進度 |
| `lib/media.js`、`lib/hls.js` | 共用的純函式（分類、檔名、m3u8 解析），有單元測試 |

## 開發

```sh
npm test        # 單元測試（node --test）
npm run icons   # 重新產生 icons/*.png
```
