# 设计文档 · 尼姆堆

面向维护者：为什么这样实现、哪些约束一破就出 bug、契约禁止的"点击时现场搜索"在本仓的边界在哪、
难度带的两个数字是哪一次实测产出的。玩法与关卡表见 [README.md](README.md)，
"磁盘上真实存在且已验证"的清单与改动表见 [deliverable.md](deliverable.md)。

---

## 1. 三层，以及"浏览器不搜索"这条结构性事实

```
js/core/*.js   纯函数。不出现 window / document（唯一例外 storage.js，守卫式访问 localStorage）
js/view.js     像素与手势。不判合法性、不判输赢
js/main.js     DOM、路由、存档、面板；把 window.nim 挂出来给台架用
```

依赖方向只有一个：`main → view`、`main → core`、`view → core/bouton`。
`view.js` 只 import `bouton.js`（画绿框要用当前必胜着集合）与 `heaps.js` 的 `isTerminal`；
`make.js`（生成器）与 `retro.js`（搜索器）**不被任何页面文件 import**。
这条不是风格偏好而是可测的事实：`test/library.test.mjs` 里
"the browser cannot search: nothing it loads imports the solver or the generator"
会读 `index.html`、`js/main.js`、`js/view.js` 的 import 图，一旦有人把 `retro.js` 接进前端就红。

于是"点击时只算一次异或"不需要谁去遵守纪律，它是唯一可能的写法：
一次 `verdict()` 在 1e6 次循环里实测 28 ms（≈28 ns/次，node v26.8.1），
而一次倒推分析在烘焙网格上是 10,000 状态 / 180,000 条边、两遍规则约 20 ms。

## 2. 主张：闭式必须被一次独立复算顶起来

`bouton.js` 是定理，`retro.js` 是穷举。两者共用模型（`heaps.js` 的 `[n1..nk]` + `{i,to}` 着法），
**不共用一行判定代码**——这是"独立第二证据"的全部含义。

倒推分析的写法（`retro.js`）：

1. `gridOf(maxVec)` 把 `[0..maxVec[0]] × …` 摊成一维 id（混合基数），零长度堆等价于短一截的位置，
   所以一张网格同时服务所有 `k ≤ maxVec.length`（`0` 堆对异或与着法表都是中性的）。
2. `reverseEdges()` 建 CSR 反向边表：`list[X]` 是能吃进 X 的那些位置。
3. **唯一一处两规则分岔**：终局（全盘空）在 normal 下标 P（轮到谁谁输），在 misère 下标 N
   （对手刚被迫取走最后一枚）。这条 base case 之后，向外扩散的规则一字不差：
   有 P 后继者标 N，后继全 N 者标 P。
4. 桶按"剩余石子数"递增抽干，所以一个位置第一次被标 N 时它的 `plies` 已经最小；
   而 P 位的 `plies` 取所有后继的最大值，最后一个后继关闭时它就是终值。不需要第二轮、不需要迭代到不动点。

`par` 因此是**"赢的一方走最短、输的一方拖最长"时的总步数**，与 `game.js` 里 `plies` 的计数单位一致
（一手 = 你一步 + 对手一步 = 2 plies），所以 `已走 / par` 是同量纲可比的两个数。

三路复算，全部是真测试：

| 证据 | 范围 | 测试行 |
|---|---|---|
| 全量倒推 vs 闭式 | `k ≤ 3`、`n_i ≤ 7` 的 512 个状态，normal 与 misère 各一遍 | `test/retrograde.test.mjs` "normal play: all 512 states agree…"、"misere: the same full sweep, same zero" |
| 两规则的分歧区域 | 统计分歧态数 > 0，且**恰好**落在"所有堆 ≤ 1"的区域 | 同上 "the two rules do disagree, and the disagreement is exactly the all-heaps-<=1 region" |
| 独立自顶向下 minimax | 与倒推完全不同的实现（`test/minimax.mjs`），逐态比 outcome 与长度 | "…with the naive minimax, and on depth" |
| 序列化产物重解 | 从 `js/data/lots.js` 读回 54 行，在自己的可达盒 + 共享网格上各解一遍 | `test/library.test.mjs` "every shipped number solves again from scratch…" |
| 浏览器里的第四意见 | 台架自己敲一遍 Bouton + minimax，扫全 54 行 × 2 规则 | `@boot` "every shipped row survives a third opinion in the browser" |

`winMoves` 的第二证据特意不用闭式：`resolveState()` 数的是"被倒推标成 P 的后继个数"。

## 3. misère 不是加个提示

`bouton.js` 头部把推导写全了，摘要：

* 还有两堆以上 ≥2 枚时，一步不可能把所有大堆都变小，所以"把异或打成 0"的目标天然落在 normal 区域里，
  两规则同解。
* 只剩**一个**大堆 `v` 和 `c` 个单石堆时，`xor = 0` 的目标是 `v xor (v xor (c&1)) = c&1`，
  即 0 或 1 —— 它落在"全小堆"区域，而那里 `xor = 0` 意味着**偶数个单石堆**，对下一步走的人反而是好事。
  于是常规着法恰好是输着，正确的做法是留**奇数**个单石堆：`c` 偶 → `v → 1`，`c` 奇 → `v → 0`。
  这个区域里必胜着恰好一条。
* 全小堆时按单石堆奇偶判：奇数 = P，偶数 = N。
* 终局（全 0）在 misère 下是"轮到手已经赢了"，所以 `winningMoves = []` 而 `verdict().over = true`
  用来把它和真正的 P 位区分开（`test/anchor.test.mjs` 专门钉了这条）。

关卡侧的体现：`oddball` 档（`1,1` 与 `1,1,1,1`）在 normal 下是 P 位、在 misère 下是 N 位，
`make.js` 用 `other: 'P'` 把这个反常条件写进生成窗口；烘焙表里 `verdicts invert on 2` 就是它。
`winMoves` 的奇偶定理（正常规则下必胜着数必为奇数）也是同一处的支撑：
偶数只可能出现在全小堆区域。

## 4. 手势：为什么是"两下"而不是拖拽

一条规则决定输入设计：**一次只能动一堆**。在一个拇指的界面上，"拖一堆里的 3 枚"要表达两件事
（哪一堆、几枚），单靠落点做不到不含歧义。所以：

1. 点某一堆 → 抬起（列高亮，画出一列标着 `0..size` 的虚线框）。
2. 点其中一条框 → 提交 `{i, to}`。
3. 抬起状态下点**另一堆** → 什么都不发生（不判、不计、不写 history），只提示一次；
   点棋盘空白 → 放下。

`view.js` 里 `hit(clientX, clientY)` 与 `point(i, to)` 共用同一份 `cols`（每帧 `layout()` 算一次），
所以"测试瞄准的像素"和"程序认为的堆"不可能漂移。`point()` 返回 client 坐标，正是
`Input.dispatchMouseEvent` 要的坐标；台架 `@pointer` 全程用它，从不猜。

`to = size`（最上面那条空框）由 view 如实上报、由 `game.js` 拒绝：
"取 0 枚"的判定只有一份实现，view 不复制规则，所以一个乱点的像素不可能跟一条测试打架。
跨堆同理：view 只报 `{i, to}`，`main.js` 的 `takeTap` 负责拒绝，`game.js` 负责最终裁决。

DPR：`render()` 每帧按 `devicePixelRatio`（夹在 1..3）重设 `canvas.width/height` 并 `setTransform`，
CSS 高度由内容（最大堆 + 一条空框）决定，所以堆多的关会自动长高。
台架有一条断言盯着"canvas 不是未样式化的 300×150"（本机 overlay 滚动条下回显
`canvas backing store: 620x180`，经典 15px 滚动条下 `605x180`）。

宽度不是我们算出来的，是页面借给我们的：`#board` 是 `width:100%`，它的宽由"这一列多宽"决定，
这一列的宽又由"页面是否纵向溢出"决定。面板填满内容后页面越过视口，在滚动条占位的平台上会有
15px 从这一列消失，而窗口尺寸没变、`resize` 不会响——按 620 定的 backing store 就一直在画一只
605 的盒。两处各自封住这条边：`css/game.css` 给根滚动容器 `scrollbar-gutter: stable`（实测同一只
`width:100%` 的盒在溢出与不溢出两样都是同一宽度，overlay 平台预留 0）；`js/view.js` 挂
`ResizeObserver`，盒宽与 `layout()` 上次用的宽不一致就重画（比的是宽度，自己改高度不会把自己
再触发一遍）。`destroy()` 会断开这个 observer。

## 5. 路由、存档与确定性

* `#/<route>/<id>`：`#/lot/<id>` 开某一关；`#/daily` 每日一题；`#/`（或任何认不出的地址）落回战役指针。
  认不出的地址**不会**被悄悄换成随机关卡：弹一条 toast 再落回战役，
  分享链接打错字与"打开第 1 关"是两件不同的事（`@routes` 钉了这两条）。
* `applyRoute()` 对非 `lot` 路由用 `history.replaceState` 把地址写成可分享的形状；
  `replaceState` 不触发 `hashchange`，所以高亮要手工同步（`renderTotals`）。
* 每日一题：`dailyLot(todayKey())` → `pick(ALL, 'YYYY-MM-DD', 'daily')` →
  `hashSeed('daily|<date>') % 54`。`hashSeed` 是 FNV-1a **派生**的两轮 UTF-16 混合
  （每个 code unit 先异或低字节乘一次、再异或高字节乘一次），**不是教科书 FNV-1a**：
  `hashSeed('a') = 723832900`，公开向量 `3826002220`。文档与测试都不拿公开向量当期望值，
  只断言自洽（同种子两次相等、邻居种子不相邻、`>>> 0` 在 32 位内）。
* 存档 `nim.save.v1`：`records[id] = {plays, won, best?, perfect, lastWon, lastPlies, par}`、
  `daily[dateKey]`、`unlocked`、`stats`。没有 `window` 时退化成内存（node 测试就跑在这条路上）；
  坏 JSON / 敌意形状逐字段回落；`best` 只降不升、输棋不写 `best`、`unlocked` 只升不降、
  `reset()` 连磁盘一起清（`test/storage.test.mjs` 12 行）。
* `unlocked` 与货架格子都按 **ALL 里的位置**算（`ALL.indexOf(lot) + 1`）。
  `lot.index` 是**档**的下标，两者混用会做出"过了 knife-12 只解锁到第 3 关"这种事，
  见 deliverable 改动表。

## 6. 对手

`ai.js` 没有随机数、没有难度旋钮：局面 N 就取闭式的第一个必胜着，局面 P 就从最大堆取一枚拖着。
后者是启发式，不是 `par` 用的那个最大化者——这一点必须写清楚，否则"完美玩家"会被误读成"会打最短局"。
它只会让必输的局更早结束，因为 `par` 已经对所有拖延取过最大值。
玩家侧同理：不走"最短的必胜着"就可能赢了但超过 `par`，`grade()` 用 3 星 / 2 星区分，
`perfect` 是"步数 ≤ 实测 par"这个可复算的事实。

实测（`tools/playtest.mjs` 里独立敲一遍的判据 + 同一份逻辑在 node 里跑一遍）：
**每一关**都按"最短必胜着"打，54/54 关的结束步数正好等于印着的 `par`。
这条同时是 `@pointer` 敢断言 `plies === par === 5` 的依据。

## 7. 生成实测：结构量与计时量分开写

结构量（逐位可复现）：54 关、6 档、每档的 `par` 区间与 `winMoves` 分布、
`cells`（该关自己可达盒的状态数）——见 README 的表；重跑 `node tools/bake.mjs` 产物 byte-identical。

计时量（随机器与负载漂移，下面这次是 2026-09-27、node v26.8.1、本机、与验收同一台机器同一时段）：

| 量 | 实测 |
|---|---|
| 整次烘焙（54 关，两规则，每关量两遍） | 0.14 s 墙钟 |
| 共享网格 9×9×9×9 = 10,000 状态 / 180,000 反向边，两遍规则 | ≈ 20 ms |
| 最宽可达盒 6+7+7+8 = 4,032 状态，两遍规则 | ≈ 6 ms |
| 闭式 `verdict()` | 1e6 次 28 ms（≈28 ns/次） |
| 接受率（found / 探测到的候选数） | spark 8/370 ≈ 2.2%、nerve 12/189 ≈ 6.3%、knife 12/36 ≈ 33%、deep 10/72 ≈ 13.9%、twitch 10/850 ≈ 1.2%、oddball 2/2 = 100%，合计 54/1519 ≈ **3.6%** |

**接受率远低于契约的 20% 线，这是明写在这里的事实**：窗口是 `(par, winMoves, shape, sum)` 四重约束，
而 `winMoves` 在正常规则下只能取奇数值（1 或 3），`knife`/`deep` 要求"恰好一条活路 + 长局"，
`twitch` 要求"恰好一个大堆"，所以绝大多数候选被拒是设计使然。
代价由"只在构建期跑"吸收：0.14 秒、54 关、产物进 git，浏览器一次搜索都不做。
拒绝原因（`notN`/`parLow`/`parHigh`/`sumLow`/`sumHigh`/`shape`/`winLow`/`winHigh`/`dup`）由
`tools/bake.mjs` 逐档打印，不是"试了 900 个留了 12 个"这种黑账。

## 8. 台架（CDP）踩过的坑，一条都别改回去

* **导航之后轮询 shell，不要 `sleep()`**：`waitShell()` 轮 `window.nim.state.id`。
  固定 sleep 在 localhost 够用，打线上就是三条假故障（canvas 停在 300×150）。
* **Chrome 用 `mktemp -d` 独立 profile**，`trap cleanup EXIT` 里把**所有**后台 PID（含看门狗）`wait` 掉，
  否则结尾刷一堆 `Killed: 9`；看门狗要 `</dev/null >/dev/null 2>&1` 重定向，不然它继承管道写端把消费者卡住。
* **双就绪轮询**：`/json/version` 与 web 根目录都活才开始。
* **结果 JSON 用花括号计数**从 console 里截，不要 `JSON.parse(整行)`（headless 会在同一行追加文本）。
* **端口独占检查**：`verify.sh` 开头探测 `:$CDP_PORT`，已有东西应答就 `exit 9` 并 `pgrep -fl remote-debugging-port`
  把肇事者打出来。死代理留下的 orphan Chrome 会把验收伪装成"0 行失败"。本仓用 **:5193 / :9353**，
  不能撞 gridlock 的 :5180/:9340，也不能撞兄弟仓的 :5181/:9341 与 :5185-:5192/:9344-9352。
* **`<link rel="icon" href="data:,">`**：不是装饰，少了它 favicon 的 404 会污染 console 断言。
  本仓不声称任何 SVG 图标，就是空 data URI。
* **`@reloaded` 必须是独立进程 + 真导航**：它是唯一能区分"模块缓存里还热着"和"真的落盘了"的一段，
  所以 `@save` 结尾要留一局在磁盘上（它自己会先 `wipe` 再重下一局）。
* **场景字符串里的注释不能写反引号**：整段是模板字面量，一个反引号会提前终结它，
  报的是 `SyntaxError: Unexpected identifier`（本项目真踩过，见 deliverable 改动表）。
  正则里的 `\d` 也要写成 `\\d`；能用 `indexOf` 就别用正则。

## 9. 刻意不做

随机化/可调弱的 AI（闭式就是它的证据，调弱是掷骰子化妆成设置）；多人对战、排行榜、每日对战；
成就/签到/内购/云存档/分享战绩（分享只分享谜题 `#/lot/<id>`）；Wythoff、Moore 等变体（判据是另一套定理）；
图片/音频/字体资产与打包器；点击时的任何搜索。
