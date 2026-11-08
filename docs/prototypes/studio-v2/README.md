# ohoo Studio v2

[在浏览器打开原型](index.html)。页面将 React、React Flow、Radix Dialog、Lucide 和样式一并打包，可离线演示。浏览器存储仅包含示例数据。工作区选择器里的「重置演示」会恢复初始样例。

## 修改与构建

运行环境建议 Node.js 22。在此目录执行：

```sh
npm ci
npm run build
```

生成的 `index.html` 可直接打开。入口和导航在 `src/App.jsx`，示例数据和路由在 `src/studio.jsx`。团队目录与设计器、运行与快照画布、角色会话、部署管理分别在 `Teams.jsx`、`Runs.jsx` / `RunMap.jsx`、`Session.jsx` 和 `Admin.jsx`。

通用团队通过节点与交接规则运行。订单模板额外提供设计评审、QA、灰度与回滚的交互演练。修改该示例的流程结构或完成条件后，新运行使用租户配置的通用交接。设备发现、模型执行和生产动作均为模拟。
