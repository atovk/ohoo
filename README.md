# ohoo

ohoo 是一个多租户的 Team 流程编排平台。租户可以在自己的工作区创建团队，定义真人与 agent 的角色、交接规则和完成条件，并复用这些规则开展工作。

一期聚焦团队编排和角色 agent 操作台。成员点击已配置的角色节点，打开类似 Paseo 的会话面板，直接下指令、查看输出、补充飞书文档链接或会议材料。Agent 按本角色已有的 skills、CLI 和成员账号处理这些输入，选定的产物再按团队规则交接。

## 运行本地 MVP

根目录是可运行的单工作区应用。React 工作台调用本机 API，API 通过 Paseo SDK 操作真实 coding agent，SQLite 持久保存团队、运行、私聊及已提交的产物。`docs/prototypes` 中的页面是独立的设计演示。

环境需要 Node.js 22.13+，以及已启动的本机 Paseo daemon 和至少一种可运行、已登录的 coding agent。本项目固定使用 `@getpaseo/client@0.15.2`。在项目根目录执行：

```sh
npm ci
npm start
```

服务默认监听 [127.0.0.1:4310](http://127.0.0.1:4310/)。另开一个终端运行 `npm run open`，用本机所有者身份打开工作台。首次进入时会看到真实空工作区，后续打开保留已有数据。

**第一次交付**：

1. 到「执行环境」检测本机 Paseo 报告的 provider 与模型。推荐先选一种已能在这台机器上完成真实任务的 CLI。
2. 到「成员」生成一次性邀请，在**另一个浏览器配置文件或隐私窗口**兑换。回到所有者窗口刷新成员；也可以先把两个角色都指派给自己体验。
3. 创建团队，依次添加 agent「需求整理」和真人「签收负责人」。配置职责、工作目录、skills、CLI 名称、产物类型和必填字段，分别指定本人及接收成员，保存流程。
4. 发起运行，点击当前 agent 节点，再发送任务和补充上下文。离开或刷新后，回到同一节点继续同一个 Paseo 会话。链接按用户输入处理，能否读取由 agent 本身已有工具决定。
5. 明确选定交付正文、字段和摘要，预览后提交。接收人在「待我签收」查看该版本，可以退回修订或签收。终点签收后运行关闭。接收人不会收到原始角色对话。

**两个 agent 接力。** 新建团队时可以选择「需求与研发设计评审」模板。开发角色在上游提交后自动启动。负责人可以保存新的设计修订、退回，或按指定版本确认开工。确认开工会把批准的方案交回同一个开发 agent 实施。[准备示例项目与完整操作步骤](docs/local-design-handoff.md)

**开发、QA 与测试环境发布。** `npm run example:release` 创建订单示例的独立副本。选择「开发 → QA → SRE 测试发布」模板，核对团队测试、部署和验证命令。实现产物以不可变摘要送测，失败退回修复，只有 QA 验过的候选才能部署并验证。[操作步骤与回执说明](docs/local-test-release.md)

### 本地配置

| 环境变量 | 默认值和用途 |
| --- | --- |
| `OHOO_PORT` | `4310`，工作台的本机端口 |
| `OHOO_PASEO_URL` | `ws://127.0.0.1:6767/ws`，后端连接已有 daemon 的地址 |
| `OHOO_PASEO_PASSWORD` | 仅在 daemon 要求密码时由服务端读取 |
| `OHOO_DATA_DIR` | `~/.local/share/ohoo-mvp`，保存工作数据、登录会话及所有者访问密钥。`owner.key` 属于本机所有者 |
| `OHOO_WORKSPACE_ROOT` | 默认是数据目录下单独的 `work` 目录。可设为本人可信的已有项目目录；角色的工作目录须在此根目录内 |
| `OHOO_OWNER_NAME` | 首次建库的所有者显示名，默认「本机负责人」 |

工作目录限制用于选择项目，**本机 CLI 仍按其操作系统账号的实际权限运行**。当前实例只监听 loopback。本机所有者可绑定本人的 Paseo 环境；受邀成员可使用自己的登录身份领取真人工作。此切片支持顺序交接、可选的 agent 自动接手、版本化设计评审及开工后的实施回交。复杂分支、独立租户服务及远程执行机注册仍属后续范围。

角色的 skills 和 CLI 名称会进入角色指令，实际调用取决于执行环境已有的工具和账号。需要工具许可时在 Paseo 原会话处理。回执不明时，ohoo 按原消息 ID 核对，不会重新下发同一任务。

### 验证

`npm test` 运行自动化测试。以下真实集成测试会在 Paseo 创建一条新的测试会话并实际调用模型。`OHOO_TEST_MODEL` 取本机发现列表中的模型 ID。

```sh
OHOO_TEST_LIVE_PASEO=1 OHOO_TEST_PROVIDER=codex OHOO_TEST_MODEL=gpt-6.1-sol node --test tests/paseo.test.mjs
```

**本机验收记录 · 2026-11-08。** 使用两个独立 Chrome 浏览器身份操作真实页面。需求起草角色通过 Paseo Desktop 0.15.2 调用本机 Codex；在同一会话补充会议决定，第二轮正确复述第一轮校验词并据此输出验收样例。负责人仅提交需求正文、必填字段及交接摘要。受邀成员签收 v1 后，运行已完成。该成员访问起草角色的私聊得到 HTTP 403。验收保留在当前机器的数据目录，其他安装从空工作区开始。[查看本机运行](http://127.0.0.1:4310/#/runs/e1a2ef38-c23b-417a-bb22-22fd99a2b5d7) · [验收截图](docs/media/mvp-local-handoff.png)

## 项目资料

- [多租户 Team 流程编排平台产品设计](docs/team-orchestration-product-design.md) 涵盖租户自助建队、角色和协作规则、运行与验收，以及内容编辑和订单研发两种配置示例。
- [轻量 MVP 技术方案](docs/team-orchestration-technical-design.md) 说明如何从节点创建或续接角色会话、处理用户补充的材料、绑定个人工具并交接团队自定义产物。
- [Studio v2 完整工作台设计](docs/team-studio-v2-design.md) 配有[新版可点击 React 原型](docs/prototypes/studio-v2/index.html)，覆盖首次使用、组队、节点会话、人机评审、测试发布及产物归档。
- [团队工作台界面与交互设计](docs/team-workbench-ux-design.md) 配有[可点击的离线原型](docs/prototypes/workbench.html)，可体验团队画布、节点会话、版本交接及两种部署的管理设置。
- [Agent 开发工作台开源方案调研与选型建议](docs/research/2026-10-26-agent-workbench-survey.md)：Paseo、Orca、HAPI、T3 Code 等方案对比，包含网络身份边界、建议架构与 PoC 验收项；2026-11-02 补充 Orca。

本地 MVP 和设计原型分别提供运行入口，企业部署及多租户目标以设计文档为准。
