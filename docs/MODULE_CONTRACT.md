# 模块接口与并行开发约定

`src/shared/types.ts` 是唯一跨模块消息协议。`src/scenarios/city.ts` 提供地图和造价配置。主代理统一契约、依赖、集成与最终试玩；Terra 子代理按文件范围分批并行，不同时改写同一模块。

| 模块 | 边界 | 依赖 / 公共接口 |
|---|---|---|
| network | 自由轨道几何、吸附、切分、施工计划 | shared、scenarios；纯函数 `planTrack`，不改写状态 |
| interaction | 草稿、端点解析、预览与拓扑有效性 | network、shared；`draftStatus`、`pointForNode` |
| simulation/demand | 独立 OD 和出行方式选择、等待估计 | 类型与配置；独立随机流，建设不改变 OD |
| simulation/economy | 空驶和载客的运营成本 | 纯计算函数 |
| simulation/index | 路由、资源预约、车辆执行、事件、存档 | network、demand、economy；`createGame`、`advanceGame`、`applyCommand`、`getSnapshot`、`serializeGame`、`deserializeGame` |
| rendering | PixiJS 地形、建筑、轨道、车辆、相机和命中检测 | shared、scenarios；`createMapRenderer(host, callbacks)` |
| ui | 稀疏游戏 HUD、对象操作、双语、导入导出入口 | interaction、rendering、shared；`App(props)` |
| app / worker | 状态唯一写入者、请求应答、自动保存与生命周期 | 模拟公共接口；SimulationBridge |
| tests | 几何、规则、独立轨迹审计和异常存档 | 通过公共接口验证，少量内部结构用于独立审计 |

开发工作细分为调度、地图渲染、界面、网络编辑、操作交互、客流经营、独立 QA，以及后续建筑美术整理。各代理只编辑分配文件、相应测试和模块文档；不是简单增加同时修改同一套文件的人数。

模拟不得引用 DOM、React 或 PixiJS。UI 发送意图而不直接改资金/网络/车辆。渲染只把坐标与对象 ID 交给 UI，不决定施工是否合法。预览与提交都使用同一份 `planTrack`；提交在 Worker 中再次验证当前资金和预约，成功后一次性应用。

所有用户可见内容提供 zh/en；动态消息使用 Localized。图形资产由代码绘制。文档记录当前规则和可观察限制，不能把占位字段当成已完成功能。
