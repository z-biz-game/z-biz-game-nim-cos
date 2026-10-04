# 尼姆堆 · NIM

桌上摆着几堆石子，两人轮流从**一堆**里取走任意多枚（至少一枚，不许跨堆、不许不取）。
取走最后一枚的人胜（`normal`），或者取走最后一枚的人负（`misère`）。
这是一个已经被完全解决的游戏：Bouton (1902) 给出闭式判据，本仓把那条闭式和一次**完整的倒推分析**
（穷举整张有界博弈图）逐状态对账，屏幕上每个数字都是这么来的。

```
npm start          # 本机 http://127.0.0.1:5193/（这仓的端口；被占就 node server.cjs <其它端口>）
node --test test/  # 纯逻辑层：5 个套件
bash tools/verify.sh   # 一次性验收门：node 套件 + 真实 Chrome + 真实鼠标事件（:5193 网页 / :9353 DevTools）
```

零依赖、零打包器、零二进制资产：画面全部由 canvas 2D 程序绘制，`dependencies` 与 `devDependencies`
都是 `{}`。ES module 需要 origin，所以必须经 `server.cjs` 打开，`file://` 会被 CORS 挡掉。

## 玩法

1. 棋盘是几列石子，每列一堆。列头的 `1:2` 表示"第 1 堆，2 枚"。
2. **点一堆 → 再点一条虚线框**：抬起的那堆上会出现标着数字的框，框上的数就是"把这堆剩成几枚"。
   最上面那条空框等于"取 0 枚"，游戏会拒绝它。点棋盘空白处放下抬起的堆；点另一堆不算棋。
3. 键盘等价：数字键 `1..4` 抬起对应堆，再按一个数字键就是把那堆留成那个数，`u` 回退一手（连同对手的回应），
   `r` 重开，`Esc` 放下。
4. 右侧面板印三个数：`开局判定`（这一关的 N/P，烘焙时量的）、`本步是否必胜`、`剩余必胜着法数`
   （这两条是当下局面的闭式判定，O(k)）。绿框就是当前所有必胜着法。
5. 规则可以在两种取胜约定之间切换，石子一颗也不动，只有"谁赢"变。
6. **对手是完美玩家**：它每步直接取闭式给出的必胜着，没有随机、没有难度可调，也没有让它变笨的开关。
   一旦你走成 P 位交回它手，这局就已经不属于你了——这不是修辞，是定理。
7. 分享只分享谜题本身：`#/lot/<id>`。每日一题 `#/daily` 由 `hashSeed('YYYY-MM-DD')` 选局，
   任何设备、任何浏览器上看到同一堆石子。成绩只存在本机 `localStorage`（键 `nim.save.v1`）。

## 屏幕上的数字从哪来

| 数字 | 谁算的 | 独立复算 |
|---|---|---|
| `outcome` ∈ {N, P} | `js/core/bouton.js`：`xor(所有堆) === 0` 即 P 位（misère 在"每堆都 ≤ 1"的区域反过来） | `js/core/retro.js` 的完整倒推分析，逐态对账 |
| `winMoves` | 同一文件：把第 i 堆改成 `h_i xor X`，凡结果变小者就是必胜着 | 倒推分析数"被标为 P 的后继个数"，不共用一行代码 |
| `par` | 倒推分析：赢的一方尽量走短、输的一方尽量拖长时的**总步数**（双方都计） | `test/minimax.mjs` 里一个独立的自顶向下 minimax，加上浏览器里再敲一遍的判据（`@boot`） |
| 关卡与难度带 | `js/core/make.js` + `tools/bake.mjs`（构建期） | `test/library.test.mjs` 从序列化后的 `js/data/lots.js` 重解每一行 |

**浏览器在点击时不做任何搜索**：`make.js` 与 `retro.js` 不被任何页面文件 import，
这条结构性事实本身就是 `test/library.test.mjs` 的一个断言。

复现那张表：

```
node tools/bake.mjs      # 重写 js/data/lots.js 并打印下表；重跑两次产物 byte-identical
```

2026-09-27 本机实跑（node v26.8.1，`bash tools/verify.sh` 的 node 段同一台机器）：

```
pool: 54 lots
  spark    火花 normal n=8   par 5-9  (median 7)   winMoves {3:8}   heaps 3-3  stones 6-14   own box 175
  nerve    神经 normal n=12  par 11-13 (median 11)  winMoves {3:12}  heaps 3-4  stones 11-17  own box 525
  knife    刀口 normal n=12  par 11-19 (median 16)  winMoves {1:12}  heaps 4-4  stones 15-24  own box 1728
  deep     深水 normal n=10  par 23-27 (median 23)  winMoves {1:10}  heaps 4-4  stones 23-28  own box 4032
  twitch   歧途 misere n=10  par 4-4  (median 4)   winMoves {1:10}  heaps 3-4  stones 5-11   own box 64
  oddball  反面 misere n=2   par 2-4  (median 3)   winMoves {2:1 4:1} heaps 2-4 stones 2-4   own box 16
  campaign first lot spark-01, last oddball-02
  measure() (shared grid) agrees with the shipped rows (own-box grid) on all 54 lots: true
```

难度带是**两根实测坐标**，不是形容词：`par`（局长）与 `winMoves`（开局有几条活路，越少越窄）。
最深的 shipped 关是 `deep-10`（6+7+7+8，`par 27`，自己的可达盒 4,032 个状态）；
`knife`/`deep` 两档的 `winMoves` 恒为 1，意思是"走错一步就回不来"这句话在这里是数出来的。
`spark` 与 `nerve` 的 `winMoves` 恒为 3——正常规则下必胜着法数**必为奇数**（它数的是持有异或值最高位的那些堆，
见 `test/anchor.test.mjs`），偶数只出现在每堆都只有一枚的区域，那正是 `oddball` 档。

## 手推锚点（全部是真测试，不是文档里的传说）

```
node --test test/anchor.test.mjs
```

* `xor(3,5,7) = 1` → N 位，必胜着法**恰好**三条：`2,5,7`、`3,4,7`、`3,5,6`（`3⊕1=2`、`5⊕1=4`、`7⊕1=6`）。
* `(3,4,5)`：`xor = 2` → **N 位**，唯一通向 P 位的着法是 `1,4,5`。这一条被写进 DESIGN 的改动表：
  主代理一开始凭手推把它当成 P 位，探针实测直接推翻。本仓的全部主张就是"结论来自算，不来自觉得"。
* `(1,2,3)`：`xor = 0` → P 位，`winMoves = 0`。
* `(1,1)`：正常规则下是 P 位，misère 下是 N 位——两条规则**确实**会给出相反结论，
  而且这种分歧只出现在"所有堆 ≤ 1"的区域（`test/retrograde.test.mjs` 全量统计过）。

## 验收

* node 层：55 行具名检查、11,162 条实际执行的断言、fail 0（`bash tools/verify.sh` 的 node 段直接印这两个数）。
* 浏览器层：126 行、fail 0，`@boot @play @routes @save @reloaded @pointer` 六段，
  其中 `@pointer` 用 CDP `Input.dispatchMouseEvent` 真点，走完一条认证必胜线并停在 `par` 上。
* 全量对账：`k ≤ 3`、`n_i ≤ 7` 的 512 个状态，倒推分析与闭式**逐态**比对，normal 与 misère 各一遍，
  0 处不一致；另在烘焙用的 10,000 状态共享网格上再对一遍。

## 已知边界

* 只做到 `k ≤ 4`、`n_i ≤ 9` 的网格（烘焙引擎），模型上限 `MAX_HEAPS = 6`、`MAX_HEAP = 63`；
  超出就抛 `RetroCap`，不会返回一个截断的错误数字。
* 生成器的接受率很低（54 关共探测 1,519 个候选 ≈ 3.6%），所以出题**只在构建期**跑；
  实测整次烘焙 0.14 秒，详见 DESIGN §7。
* 对手的"拖延"是启发式（从最大堆取一枚），不是 minimax 的最大化者，所以它只会让必输的局**更早**结束；
  玩家若不走"最短的必胜着"，实际步数可能超过印着的 `par`（`grade` 因此区分 3 星与 2 星）。
* P 位不作为关卡：玩家无论如何都输，那是假关卡。
* `hashSeed` 是 FNV-1a **派生**的两轮 UTF-16 混合，不是教科书 FNV-1a：`hashSeed('a') = 723832900`，
  公开向量是 `3826002220`。测试里只断言自洽性（同种子两次相等、邻种子不相邻、`>>> 0` 落在 32 位内），
  不拿任何公开向量当"应等于"。
* 不做：随机化 AI、多人对战、排行榜、每日对战、成就/签到/内购/云存档；
  Wythoff、Moore 等变体的判据是另一套定理，不在本仓，锚点不复用。

## 上线的到底是哪一批文件

这个仓没有打包器：站点=一次文件拷贝。以前「拷哪些」写在 `pages.yml` 的 `run:` 里（手抄的几行
`cp`）。本地 `index.html` 直读仓库根，永远自洽；线上却按那份清单拷，于是页面后来引用的
`manifest.webmanifest`、`sw.js`、`icons/*` 可能一个都没上去——线上 404，而仓里的引擎测试与
真浏览器闸全绿，因为它们跑的都是仓库根，没有任何一步在「按清单拷」的那个环境下加载过页面。

现在清单只有一份，住在 `tools/assemble-site.sh`：CI 调它拷 `_site`，本地闸调它拷临时目录，
然后**对拷出来的产物**提要求（`tools/deploy-set.mjs`）：

- **W 清单与页面同源**：`pages.yml` 里必须真有 `run: bash tools/assemble-site.sh <dir>` 这一行，
  `ci.yml` 里必须真有 `run: node tools/deploy-set.mjs`。认的是调用那一行，不是文件里出现过这个
  路径——注释里本来就会写它，只 grep 字符串会被一句散文喂绿。
- **R 引用可达**：引用不靠手打名单。从 `index.html` 的 `href/src` 出发，凡解析出来是 `.js`/`.css`
  的就把那一站也扫一遍（CSS 的 `url()`、JS 去掉注释后的 `'./…'` 字面量、`new URL(x, base)` 的两种
  基、`navigator.serviceWorker.register`、`scope`），`manifest` 的 icons/screenshots/shortcuts 各自
  的 `src` 也算引用。取径上读不到的那一站本身就是红（读不到＝这一站根本没扫）。每条引用都必须在
  产物里且非 0 字节；绝对路径单列一条红，因为 Pages 挂在 `/<repo>/` 前缀下会跳出去。
- **P 位图不许说谎**：`manifest` 声明的 `sizes` 必须等于 PNG IHDR 的真实宽高——文件图标读文件头，
  内联成 base64 的图标先解码再读同一段。后一条不是可选项：图标可能住在清单里而不是盘上的 `.png`
  （有的仓另有一条"零二进制文件"的承诺，那条只约束"有没有 .png 这个文件"）；如果 P 段只筛文件名，
  声明写 512 而真图 192 就一路放行。
- **钉住两个数**：R 段实际检查的路径条数（`31`）与这一次跑的断言条数（`49`），两个数
  都钉在 `tools/deploy-set.mjs` 顶部的那对常量里。没改页面却掉了，说明解析断了；删掉一张图标会同时
  少一条 R10 与那张的 P1/P2，所以两个数一起钉，断言条数能漂就是闸在缩水的信号。这一节故意只写数值、
  不写那对常量的名字，也不写别仓文档闸的编号：有的仓的文档闸会拿"文档里出现过的同名标识号"回数它
  自己的条数，还有的会把文档里点到的每个组编号逐个核对"这一轮真的发过"——两道闸共用一个名字，
  或者在本仓的文档里出现一个本仓没有的组编号，打红的都是不相干的那一边。

`tools/deploy-set-selftest.mjs` 是这两颗钉的阳性证明：它把仓库复制到临时目录，照着每一类断言
各下一刀（X1 清单不收位图目录 / X2 模块边改名 / X3 CSS 写绝对路径 / X4 `start_url` 绝对 /
X5 删光 >=512 图标 / X6 少一个必填字段 / X7 声明尺寸与真图不符 / X8 workflow 不调脚本 /
X9 CI 不跑闸 / X10 是阴性对照——往入口 JS 追加一行只写在注释里的假路径，闸必须仍然绿、条数仍然
`31`、断言仍然 `49`；X11 og:image 退回相对路径 / X12 og:image 的前缀指向别的 slug /
X13 内联位图谎报尺寸——只在有靶子时下：X11/X12 要页面上那句 og:image，X13 要清单里真有一段 base64
图标，没有就打印 SKIP；反过来 X1 没有位图目录可砍时改砍 css，P 段一位都不核时台架直接报靶子不够），
要求每一刀都让闸**点名**变红。靶子从 `DEPLOY_SET_DUMP=1`
的出处表现挑（取径真的会读的那支 JS / 那一张 CSS，不写死某一个仓的入口名），所以页面改了、仓与仓
不同，台架跟着走。

`node tools/deploy-set.mjs` 与 `node tools/deploy-set-selftest.mjs` 就是 CI 跑的那两条命令本身
（package.json 里的 `deploy-set` / `deploy-set:selftest` 只是同一支脚本的 npm 入口）；把它们接进本仓
那条浏览器 one-shot（`tools/verify.sh`）还欠着——那道脚本的腿名单与条数钉是每个仓自己的形状。

