# Prompt Caching 優化修訂方案（單人低併發場景）

本文件為 [`prompt_caching_optimization_proposal.md`](/Users/linchunchiao/Documents/openai-shared-proxy/docs/prompt_caching_optimization_proposal.md) 的修訂版建議，目標是針對目前較符合實際的使用前提重新收斂設計：

- 使用者主要為單人
- 幾乎沒有多人同時併發
- 主要需求是提升 Prompt Cache 命中率、降低輸入成本、延後免費 key 耗盡
- 不希望引入過度複雜的狀態管理或資料庫重構
- 目前 SQLite 測試資料可放棄，允許直接重建 schema

本修訂版的核心觀點是：

1. 在單人低併發場景下，**不需要優先追求多 session 均勻分流**
2. 應優先追求 **cache locality**
3. 實作上應優先採用 **固定主 key、失敗才切換**，而不是一開始就導入 session-sticky hashing
4. 在觀測面應先補齊 **cached tokens 記錄與儀表板顯示**
5. 由於目前仍在測試期，**資料庫以重建 schema 優先，不為舊資料保留 migration 相容性**

---

## 1. 為何原提案需要修訂

原提案的大方向沒有錯：目前代理層對每次請求都重新選 key，確實不利於多輪對話的 prompt cache 命中。

但原提案有三個不必要的複雜化點：

1. 它把問題建模成「多使用者、多 session 併發分流」問題
2. 它把 session 識別建立在 `messages[0] + messages[1]` 上，假設過強
3. 它使用 `hash % healthyKeys.length` 進行分配，當健康 key 集合變動時，重映射範圍會過大

如果目前實際使用情境只有單人，則上述第 1 點其實不是主要矛盾。

此時更重要的不是「怎麼讓不同 session 平均分散」，而是：

- 怎麼讓**同一段長對話盡可能持續命中同一把 upstream key**
- 怎麼在 key 失敗時有乾淨的 failover
- 怎麼量化優化是否真的生效

---

## 2. 修訂後的設計原則

### 2.1 單人場景優先順序

在單人低併發情況下，優先順序應調整為：

1. **維持同一把 key 的連續使用**
2. **保留簡單明確的 failover**
3. **補足可觀測性**
4. **最後才考慮 sticky hash 或一致性雜湊**

原因很簡單：

- 你不是同時有很多不同使用者搶同一把 key
- 你也不太需要把不同會話平均打散到多把 key
- 真正能帶來收益的是讓多輪對話保持在同一 key 上

因此，對目前場景最划算的方案不是「複雜但通用」，而是「簡單但高度對症」。

### 2.2 優先利用 upstream 已有的 cache 能力

目前 OpenAI 已經有 prompt caching 機制，代理層應做的是：

- 避免自己把同一段對話切換到不同 key
- 盡量保留相同 prompt prefix 的連續性
- 若客戶端已傳入 `prompt_cache_key`，代理層應保留並善用它，而不是自行猜測 session

代理的責任應是提升上游快取命中條件，而不是重新發明一套過度聰明但不穩定的 session 推導邏輯。

---

## 3. 建議方案：固定主 Key，失敗才切換

### 3.1 核心策略

將目前的 free key 選擇邏輯由 round-robin 改為：

1. 優先使用固定的主 free key
2. 若主 key 處於 disabled / cooldown / exhausted / quota reached，則依序嘗試下一把 free key
3. 全部 free key 不可用時，再退回 master key

此策略的好處：

- 對單一長對話最友善
- 對單人使用最簡單
- 不需要資料庫新增 session state
- 不需要額外 hashing
- 驗證成本低，回滾容易

### 3.2 行為示意

假設有三把 free key：`A / B / C`

- 平常情況：所有請求都先走 `A`
- 若 `A` 因 429 或 5xx 進入 cooldown：暫時改走 `B`
- 若 `B` 也失效：改走 `C`
- 若 `A` 恢復健康：後續新請求再回到 `A`

這樣做雖然不保證所有 session 完全黏住同一把 key，但對單人場景已足夠接近最佳化，而且比 round-robin 更能保住 cache locality。

---

## 4. 不建議第一階段直接採用的方案

### 4.1 不建議立即採用 `messages[0] + messages[1]` 作為 session hash

原因：

- 不同客戶端未必永遠保留相同訊息順序
- `developer/system/tools/response_format` 也可能影響 cache prefix
- `content` 可能是陣列而非單純字串
- 對 session 的推導規則若寫錯，會導致錯誤分桶

若未來真的要做 sticky routing，也應改成：

1. 優先使用客戶端提供的 `prompt_cache_key`
2. 若沒有，再對較穩定的 request prefix 做 canonicalize 後計算 hash

### 4.2 不建議第一階段直接採用 modulo hash

`hash % healthyKeys.length` 在 key 數量變動時會導致大量 session 重映射。

這在目前單人場景下沒有必要承擔。

若未來真的要支援多 session、多人併發，再考慮：

- rendezvous hashing
- jump consistent hash

而不是直接用 modulo。

---

## 5. 資料庫策略：直接重建 schema

既然目前 SQLite 內的測試資料可放棄，建議本次調整**不要再增加 migration 複雜度**，而是直接把資料庫 schema 整理成新的基準版本。

### 5.1 為何此時不必保留 migration

原因：

- 專案仍在早期測試期
- 現有資料沒有保留價值
- 如果現在為了保留舊 schema 相容性而加入額外 migration，之後 schema 再演進時只會持續累積技術債
- 本次又剛好要補 cache 追蹤欄位，重建比增量修改更乾淨

### 5.2 建議做法

實作上建議採用下列其中一種方式：

1. 啟動前手動刪除既有 `.db`、`.db-wal`、`.db-shm`
2. 或在開發階段由程式明確偵測舊 DB 並直接重建

本次建議採用最簡單的方式：

- 直接以新版 schema 初始化全新資料庫
- 不撰寫向後相容 migration
- 不保留舊測試資料

### 5.3 這個決策的邊界

這個決策只適用於目前開發與測試階段。

若未來此專案進入正式長期使用，再補 migration 機制即可。現階段應優先追求：

- schema 清晰
- 程式碼乾淨
- 實作速度快
- 驗證成本低

---

## 6. 第一階段最值得做的事：補強可觀測性

在改路由前後，都應先補齊觀測資料，否則無法確認優化是否真的生效。

### 5.1 建議新增記錄欄位

從 upstream response usage 中額外提取：

- `prompt_tokens`
- `completion_tokens`
- `prompt_tokens_details.cached_tokens`（若存在）

並在本地記錄中區分：

- raw input tokens
- cached input tokens
- uncached input tokens
- output tokens

### 5.2 為何這一步很重要

目前系統只累加估算的 input/output token，無法看出：

- cache hit 比例是否提升
- 哪些模型或請求型別比較容易命中
- 路由修改後到底省了多少

如果沒有這些數據，後續任何優化都容易流於感覺判斷。

---

## 7. 建議的實作階段

### Phase 1: 補觀測，不改策略

目標：

- 重建 SQLite schema，不保留舊 migration 相容性
- 記錄 `cached_tokens`
- 在 `/status` 與 `/api/status` 顯示快取相關統計
- 確認目前 round-robin 下的 cache 命中狀況

預期成果：

- 建立基準線
- 能客觀判斷下一步優化幅度

### Phase 2: 改為固定主 key 優先

目標：

- 將 `selectNextKey()` 從 round-robin 改為 primary-first failover
- 保持既有 cooldown / exhausted / disabled / master fallback 邏輯

預期成果：

- 單人長對話的 cache locality 明顯改善
- 邏輯仍維持簡單可控

### Phase 3: 若需要，再引入 sticky routing

只有在出現以下條件時才建議進一步升級：

- 開始有多個對話同時進行
- 開始有多人使用
- primary-first 導致某些 key 壓力過高
- 觀測數據證明 sticky routing 具有額外價值

此時再考慮：

- `prompt_cache_key` 優先
- canonical prefix hashing
- rendezvous hashing

---

## 8. 對現有程式碼的修訂建議

### 7.1 `src/router.ts`

目前：

- 使用 `lastFreeKeyIndex`
- 以 round-robin 循環掃描 free keys

建議第一階段改法：

- 保留健康檢查邏輯
- 改為從固定順序的第一把 free key 開始掃描
- 不再依賴 `lastFreeKeyIndex`

這樣即可從「平均分配」轉為「固定主 key，依序 failover」。

### 7.2 `src/openai.ts`

建議補強：

- 在 non-streaming response 中讀取 `usage.prompt_tokens_details.cached_tokens`
- 在 streaming 結尾解析 usage 時，也保留 cached token 資訊（若 upstream 有提供）
- 將快取相關欄位傳給資料庫紀錄層

### 7.3 `src/db.ts`

建議補強：

- 直接整理為新版 schema，不保留舊 migration 分支
- 在 `request_log` 或 `daily_usage_estimate` 中加入 cached token 相關欄位
- dashboard 匯總時顯示：
  - 今日總 input tokens
  - 其中 cached tokens
  - cache hit ratio

---

## 9. 關於 `KEY_DAILY_TOKEN_LIMIT` 的重新定義

目前 `KEY_DAILY_TOKEN_LIMIT` 是以本地累加 token 估算來判定是否 exhausted。

這裡需要先定義清楚它到底代表哪一種限制：

1. **成本預算限制**
2. **安全保守限制**

若它代表成本預算，則應考慮 cached tokens 的影響，避免高估實際成本。

若它代表安全閾值，則可以維持保守估算，但文件應清楚寫明：

- 它不是實際計費值
- 它是代理層自訂的保守限流機制

這一點建議在文件與 dashboard 中說清楚，避免後續誤解。

---

## 10. 最終建議

若目前確定只有單人使用，建議採納以下策略，而不是直接實作原提案中的 session-sticky hashing：

1. 直接重建 SQLite schema，不保留舊 migration 相容性
2. 先補 `cached_tokens` 記錄與統計
3. 將 free key 路由從 round-robin 改為固定主 key 優先
4. 保留現有健康檢查與 master fallback
5. 等觀測數據出來後，再決定是否需要 sticky routing

這樣的原因是：

- 更符合目前使用場景
- 更符合目前資料可丟棄的開發階段
- 風險更低
- 實作更快
- 容易驗證
- 若未來需求升級，也能自然演進到更完整的 sticky hashing 設計

---

## 11. 一句話版本

對目前「單人、低併發」的實際場景，最合理的 revised plan 不是先做 session hash 分流，而是：

**直接重建 schema，先補快取觀測，再把路由改成固定主 key 優先、失敗才切換。**
