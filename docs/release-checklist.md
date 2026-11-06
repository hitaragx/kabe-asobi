# 公開前のチェック（提出の日に、上から順に）

リポジトリを公開（public）にする前に、この順で確かめる。ひとつずつ印をつける。

## 1. 中身の確認（公開して困るものがないか）

- [ ] 禁止語リスト `~/.config/kabe-asobi/forbidden-words.txt` を作る（勤務先・顧客・施設・製品の名前を1行ずつ）
- [ ] 全履歴を禁止語で調べる：`git log --all -p | grep -i -f ~/.config/kabe-asobi/forbidden-words.txt | head`（0件になるまで）
- [ ] 鍵・絶対パス・ユーザー名が追跡ファイルにないか：`git grep -nE "sk-ant-|/Users/|C:\\\\Users" -- . ':!docs/release-checklist.md'`（0件）
- [ ] `recordings/`・`logs/`・`test-results/`・`.env` が追跡されていないか：`git ls-files | grep -E "^(recordings|logs|test-results)/|\.env$"`（0件）
- [ ] 子どもの映像・顔写真がリポジトリにないか（`docs/images/` を目で見る）
- [ ] 履歴の判断：9MB の模擬記録と古い言い回しを残すか消すか（消すなら履歴の書き換え。公開前にしかできない）
- [ ] `readme-wip` ブランチをリモートから消す（dev に含まれている）

## 2. 文書

- [ ] README：「デモ動画」のリンクを入れる。「Windows の実機では未確認」「本物のセンサーでの確認はこれから」を、結果に合わせて直す
- [ ] README：見本の遊びの数と名前が `web/live/` と合っている
- [ ] LICENSE を置き、`package.json` の `license` を合わせる（README の「ライセンス」も）
- [ ] `.env.example` がある
- [ ] PROGRESS.md に最後の区切りを書く

## 3. 動くことの確認（公開する版で）

- [ ] `npm run typecheck` / `npm test` / `npm run smoke` / `npm run smoke:phone` / `npm run smoke:calib`
- [ ] クローンし直して `npm install` → `npm run dev` が動く（`git config core.hooksPath .githooks` も）

## 4. 公開

- [ ] dev を main に取り込む（`git checkout main && git merge dev`、push）。GitHub の既定ブランチが main で、README が表示されている
- [ ] GitHub でリポジトリを public にする
- [ ] 提出フォームに、リポジトリと動画の URL を書く
- [ ] ハッカソンが終わったら、API キー（kabe-asobi-hackathon）を Claude Console で削除する
