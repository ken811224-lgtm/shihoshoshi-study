# 司法書士スマホ学習

AppSheet「司法書士データベース」をもとにした、スマホ用の文字中心の学習アプリ。

- 画面：`index.html` `style.css` `app.js`（GitHub Pages で公開）
- 更新：`sw.js` により、開いたとき・画面に戻ったときに新しい版へ自動で入れかわる
- データ：`gas/Code.gs`。元のシートをコピーした専用シートだけを読み書きする
- 問題データと接続先 URL は GitHub に置かない

## 版を上げるとき

`app.js` の `APP_VERSION`、`sw.js` の `CACHE`、`CHANGELOG.md` を一緒に上げて、`publish.ps1 "内容"` を実行する。
GitHub へ公開したあと、OneDrive の `claudecode\司法書士スマホ学習` と `009 ＡＣＣＥＳＳデータベース\014_司法書士スマホ学習` へ自動で保存する（`-SaveOnly` は保存だけ、`-Check` は確認だけ）。
