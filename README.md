# Future Transit · 未来交通

在青湾市建设一套楼宇直达的 Pod 网络。观察出行需求，连接住宅和目的地，经营有限车队，再通过扩容和新的连接改善拥堵。

第一版以 **Web + PixiJS** 实现。默认中文，可在游戏内切换 English。

## 本地开发

需要 Node.js 22.12+（当前开发环境使用 Node.js 26）和 npm。

```sh
npm ci
npm run dev
```

打开终端显示的本地地址，默认 `http://127.0.0.1:5173`。

```sh
npm run typecheck
npm run format:check
npm test
npm run build
npm run preview
```

若环境禁止写入默认 npm 缓存，可在 npm 安装命令后加 `--cache /private/tmp/futuretransit-npm-cache`。

## 开始游玩

1. 点击 **松庭公寓**，选择入口方向并建设楼宇端口；再为 **中央商务楼** 建端口。起始 6 辆 Pod 位于松庭公寓内部。
2. 用建造工具铺设连接两个入口的轨道。空地可用作轨道转折和分合流节点，可以先铺主干，再接入楼宇。点击建筑端点、按 Enter 或点确认提交；Esc 取消，Backspace 撤回一点。完成后开通服务。
3. 接入北岸其他住宅，争取任务奖励；按需要添购车辆、升级泊位或轨道。
4. 在需求和拥堵图层之间切换，比较缺车、楼宇接口与共享轨道造成的等待。
5. 跨过运河接入大学和体育场，迎接一次活动客流，再继续改造网络。

在右上角经营面板中可调整票价、暂停接单、保存/读取和重开。修改繁忙轨道前先暂停接单，让模拟继续运行到在途车辆排空，再切分或拆除。

票价会影响吸引力，空车也会使用轨道。修建更多连接并不自动保证更快；共享节点和方向冲突同样重要。

游戏提供本地自动存档和 JSON 导入/导出。载入和切到后台时暂停，返回后手动继续。浏览器存储被清理后，自动存档也会消失；可下载存档保留城市。

## 模块与文档

| 位置 | 内容 |
|---|---|
| `src/shared` | 命令、快照与模块类型协议 |
| `src/scenarios` | 城市坐标、设施、建造成本 |
| `src/network` / `src/interaction` | 自由轨道几何、吸附、草稿与编辑计划 |
| `src/simulation` | 独立于浏览器的需求、路由、调度、经营和存档 |
| `src/worker` / `src/app` | 模拟线程、消息桥和运行生命周期 |
| `src/rendering` | PixiJS 地图、相机、车辆与图层 |
| `src/ui` | 双语操作界面与建设交互 |
| `test_playground` | 原有 Python 安全调度实验 |

- [当前游戏设计](FutureTransit_Game_Design.md)
- [开发计划与阶段](FutureTransit_Development_Plan.md)
- [模块契约与并行开发](docs/MODULE_CONTRACT.md)
- [架构和状态流](docs/ARCHITECTURE.md)
- [玩法与界面准则](docs/GAMEPLAY_AND_UI.md)
- [验收记录](docs/VALIDATION.md)

地图与建筑采用代码绘制，不依赖在线地图、远程字体或第三方美术素材。版本与已知限制记录在验收文档中。
