# no-Chromium 小规模下游维护

此分支只维护产品限制、镜像身份保护和同步门禁。微信安装器、WeChatAppEx、共享桌面、KasmVNC、中文输入、剪贴板、文件传输、账户权限及上游 Access/PWA 实现继续来自上游。不同意维护一套独立升级服务；面板自更新 API 和旧 updater CLI 均拒绝执行。微信客户端自己的安装/更新继续可用。

## 当前基线与边界（2026-09-25）

- 上游最新非预发布 Release：`v1.5.0`，annotated tag object `bcf513eebec592fa8f85db6ed392121940b0151d`，最终 commit `14a3a27d323961c2dee2fbb963468deb2209f1a7`。
- fork/main：`8184f5c8f18e179ea1cb42d51783b41a55920622`，原工作区干净，原 main 保留。独立 `no-chromium` 从稳定版建立，未 cherry-pick 旧补丁。
- 已 fetch 上游 main 到 `refs/remotes/upstream/main`，仅作参照；同步脚本默认跟随稳定 Release。
- 已检查 fork 其他分支：Access、PWA、empty POST、socket-proxy、权限、lockfile 等历史实现。上游已有 Access/PWA/empty POST 行为，不重放 #108/#109；secure overlay、私有账户文件权限、lockfile 构建亦在当前上游。
- 可读取部署文件位于 `/Volumes/Docker/WechatOnCloud`。这是 SMB 配置视图，不等于运行时证据。`ssh -o BatchMode=yes ...` 认证失败；**运行版本、实时 digest/revision、Compose 来源和挂载未核实**。
- 配置值：`WOC_IMAGE_PREFIX=ghcr.io/chenshu007`；`WOC_VERSION=nas-backports-20260909`；panel=`sha256:83228099d16268e2ac7fced52b3f667a796a9af04f6e3f8b1c282c7aa19ca607`；instance=`sha256:ae7f31cede2b18ec4a973e9d19602aa1047b9e427545a93b54794352aa0c9c7d`。两者是 **Docker 本地 image ID，不是已证明可拉取的 registry manifest digest**。
- socket proxy 配置：`tecnativa/docker-socket-proxy@sha256:1f3a6f303320723d199d2316a3e82b2e2685d86c275d5e3deeaf182573b47476`。配置中 panel 通过内部 `woc_proxy` 访问代理，裸 socket 被 `/dev/null` 覆盖；本次没有修改这些部署文件。
- 构建主机：macOS arm64，Node 26.9.0，本机无 Docker 命令；未启动 OrbStack/Colima，未在 NAS 构建。历史 NAS 资料指向 arm64，实时架构仍需 SSH `uname -m` / Docker info 复核。未来 CI 使用 Node 22、原生 amd64/arm64 runner，不使用 QEMU 模拟 arm64 apt。

## 行为与文件

- `panel/server/src/no-chromium.ts`：单一退役/镜像身份策略。旧 `appType=chromium` 保留，不迁移成微信。
- `store.ts` / `index.ts` / `docker.ts`：后端拒绝创建、启动、重启、升级、安装、设备身份重置和自愈；启动恢复、watchdog、批量升级跳过 retired。拒绝先于 Docker 写操作。旧容器不会被主动停止；显式停止/删除仍可用，默认删除保留卷。
- `/api/instances` 通过 `publicInstance` 返回 retired 状态和公开字段，避免把内部 Kasm 凭据展开给前端。
- 旧实例记录可查看，备份接口可导出已有容器的卷；容器已不存在时，使用已验证实例镜像创建临时只读卷导出 helper，绕过桌面入口、无网络、不启动浏览器、不创建缺失卷。单文件操作仍遵守原权限及原容器能力，不自动拉起 retired 实例。
- `docker/Dockerfile` 删除独立 Chromium 包、专用快照/固定版本/版本命令；保留 WeChatAppEx 的 GTK/NSS/X/音频等库。启动脚本明确拒绝 Chromium，移除浏览器主题和缓存清理代码，避免接触旧浏览器数据。
- 面板主题保留，创建入口移除，旧记录显示 retired，启动/重启/升级按钮禁用。客户端 API 的 Access/网络失败/空 POST 核心代码保持上游逻辑，PWA 继续构建。
- 实例只接受 `ghcr.io/chenshu007/wechat-on-cloud:<X.Y.Z-no-chromium.N>`（可附 digest）或该仓库的 digest 引用。引用不改写、不 fallback。实际镜像必须有 variant/source/revision/version 四个匹配标签，revision/version 与面板 baked 值相同；创建使用校验后的 image ID，避免 tag 在 inspect/create 之间变化。
- 镜像缺失或 pull 失败即失败；现有容器在镜像校验前不会删除。重启/启动旧镜像与指定镜像不一致时拒绝，需显式升级。已经运行的旧微信不会因面板启动而被终止。
- `version.ts` 保留真实版本和定制更新提示，停止普通版升级检测；`self-update.ts` 两个入口都 fail closed。自动旧镜像清理停用，以保留回滚材料。
- `docker-compose.yml` 必须提供两个显式引用，不能默认普通 latest；实际部署使用 secure overlay 和示例的额外 overlay。

## 本地检查与同步

```sh
bash scripts/check-no-chromium.sh
python3 scripts/sync-upstream.py                    # 默认 dry-run，只读检查
python3 scripts/sync-upstream.py --apply            # 明确建立本地候选；不 push
```

`maintenance/upstream.json` 记录上次接入 tag/SHA。脚本从本地 `no-chromium` tip 创建独立工作树和 `sync/vX.Y.Z` 分支，正常 `--no-ff` 合并上游稳定版。merge 后更新跟踪文件，运行回归、类型和前端构建检查。合并冲突立刻停，保留冲突现场并列文件；不统一 ours/theirs、不调用 LLM、不自动 abort/reset、不更改维护分支。

同目标重复运行返回已有候选及先前状态，不新建、不重做合并。候选结果/日志保存在 Git common dir 的 `no-chromium-sync/`，JSON 给出路径。冲突或测试失败后的处理是人工修复候选、提交、重新执行检查；脚本不会把既有失败候选自动当作通过。维护分支仍需人工 review 后正常合并，不能 rebase/squash 改写已记录的候选历史。`--release-json` / `--upstream` / `--check-command` 仅供隔离 fixture 测试或明确的人工诊断，不用于正式 Actions。

当前本机无 Docker，普通同步脚本只做无需 Docker 的完整检查。任何候选要发布前还必须执行下面的双镜像构建/冒烟；未来 sync Actions 在无写权限的原生 runner 上完成这部分。

## 镜像身份、构建和首次发布（本轮未执行）

Git 分支 `no-chromium` **不是镜像标签**。第一版建议使用 `1.5.0-no-chromium.1`，后续同上游补丁递增最后的 N，禁止覆盖 `latest` 或上游语义标签。版本的前三位应与跟踪文件一致。

| 产物 | 构建上下文 | Dockerfile | 镜像仓库 |
| --- | --- | --- | --- |
| panel | `./panel` | `panel/Dockerfile` | `ghcr.io/chenshu007/woc-panel` |
| 微信实例 | `./docker` | `docker/Dockerfile` | `ghcr.io/chenshu007/wechat-on-cloud` |

两者使用同一个干净 commit SHA 和相同 `WOC_VERSION` / `WOC_SOURCE_REVISION` 构建参数。标签为 `io.wechatoncloud.variant=no-chromium` 和标准 OCI source/revision/version。本轮没有发布镜像，所以**没有新 registry digest 可交付**；不得用示例占位值部署。

在另行授权的隔离 Docker 环境：

```sh
WOC_TEST_DOCKER_ALLOWED=1 WOC_PLATFORM=linux/arm64 \
  WOC_VERSION=1.5.0-no-chromium.1 bash scripts/build-local.sh
```

本地脚本仅构建+冒烟，不 push。测试容器随机名、无宿主端口、无生产卷、无网络，测试退出只删除自己的容器和匿名卷。探针检查无独立浏览器命令/包，桌面 Xvnc/openbox、DPI、中文剪贴板工具和共享库存在、微信等待安装、无崩溃循环、retired launcher 拒绝。**不等于真实微信安装、登录或 WeChatAppEx 运行成功**，后者需后续隔离安装验收、`ldd` 和交互验证。

第一次发布需独立授权：

1. review 并推送 `no-chromium`（本轮未推送）；保留原 main。先验证双镜像构建及目标架构。
2. fork Settings → Actions 明确启用 workflows；保持默认 token 只读。允许 Actions 创建 PR；release job 仅授予 packages:write。创建 `no-chromium-release` environment，配置人工审批及仅 no-chromium 分支，验证 GHCR 包权限/可拉取性。
3. 因新工作流尚不在默认分支，须另行审查并将默认分支切到 `no-chromium`，或人工在受控构建机完成首次发布。**本轮没有切换默认分支**。
4. 在选定源码 SHA 触发 `no-chromium-release` workflow_dispatch，输入唯一的定制版本。原生两架构分别先检查+构建+冒烟，再发布测试过的架构产物；全部成功后组装双镜像 manifest。没有 release/tag/push 自动触发器，不发布通用 latest。
5. 从 workflow 下载 `no-chromium-release-pair` receipt。任一架构或任一镜像失败，不允许部署；即使部分包已上传，也不是完整版本。失败重试须核对确切 SHA，源码有变化使用新 N。
6. 在允许拉镜像的验收机，再对实际 NAS 架构验证两者，只有全部通过才生成部署 receipt：

```sh
python3 scripts/verify-release-pair.py --version 1.5.0-no-chromium.1 \
  --sha FULL_VERIFIED_SOURCE_SHA --platform linux/arm64 --output release-pair.json
```

该脚本检查 registry digest，按 digest 拉两者并核对 source/version/revision/variant/架构；缺失、身份不符或 pull 失败不生成新 receipt，不降级。manifest digest 与本地 image ID 分开记录。脚本不会创建容器，但 pull 仍需对应环境授权。

## 未来同步 Actions（默认未定时启用）

`no-chromium-sync.yml` 提供 workflow_dispatch；低频周检查 cron 仅作为注释。无新稳定版时不构建镜像。仓库及分支 gate、全局并发和 job timeout 均已设置。prepare/images 用只读权限；验证候选不传 secrets，脚本在执行候选测试前移除 GH_TOKEN/GITHUB_TOKEN。

成功后，单独 propose job 不执行候选代码，只导入 git bundle、核对维护分支未变化、检查确切 SHA 和 ancestry，然后 push 候选并创建 draft PR。它只具备 contents/pull-requests 写权限。失败任务只具备 issues 写权限，按稳定版的精确 issue 标题去重；既有候选分支/PR也去重。失败日志保留在 Actions，禁止自动修冲突/自动合并/自动发布/部署。

不要依赖 token push 触发后续 CI：测试和两架构构建已在同一工作流完成，绑定 candidate SHA。GitHub 当前文档说明 GITHUB_TOKEN 创建/更新 PR 所触发的部分 pull_request runs 需要审批；其他由 token 产生的事件也不能假定会递归运行。维护者需审批单独排队的 PR CI（若配置）并核对它验证的 SHA。任何人工修复候选都要重新验证确切新 SHA，旧结果不继承。

schedule 只在默认分支运行；公共仓库无活动 60 天后可能自动停用。未来改默认分支并启用 cron 后，若失活，在 Actions 重新 Enable workflow、确认 cron/默认分支，再手动 dispatch 一次恢复检查。本轮既不修改远端默认分支，也不启用定时任务。

官方依据：
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- https://docs.github.com/en/enterprise-cloud%40latest/actions/concepts/security/github_token
- https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository

## NAS 更新与回滚（必须单独授权）

发布成功不等于部署许可。先用已授权 SSH 只读核验：架构、两个当前 image ID/RepoDigests/OCI revision、Compose project/config_files labels、环境中三个镜像设置、卷/绑定目录、PUID/PGID、端口、网络、HostConfig。不要导出完整 env/凭据；不要把 fork/main diff 当作 NAS 全部补丁。

保存原 main、旧容器/镜像（含本地 ID 与可用 registry digest）、真实 Compose/env 私有备份和数据备份，记录原 NAS 差异。将 `examples/compose.no-chromium.yml` 作为**额外** overlay 审核，不能替换现有配置；`examples/no-chromium.env.example` 只是填值模板。现有 base + secure + no-chromium overlay 顺序不可省略；显式设置实际实例网络，不能误选仅供代理的 woc_proxy。

授权后先 `docker compose ... config` 检查合并结果：panel 只能连接内部代理，socket mount 仍为 `/dev/null`，代理不发布端口，proxy digest 不变，微信数据挂载和权限不变，镜像等于 receipt 的两个 digest，不能把 baked revision/version 用旧 env 覆盖。该配置输出可能含凭据，保存到私有路径，不贴入日志。

再单独安排受控迁移和微信实例显式升级；不要只换 panel。已运行旧微信暂时保留，未通过新身份策略的旧镜像不能被启动/重启，需按批准的双镜像版本升级。旧 Chromium 不自动终止或改卷。真实登录、中文输入、剪贴板、文件传输、账户隔离、Access/PWA 必须现场验收。

回滚必须先评估从旧基线到 v1.5.0 的账号/会话/配置及微信客户端数据格式变化。本补丁不转换旧浏览器记录、不主动删数据，**但不能承诺仅换旧镜像就一定能回滚**。必要时使用一致时间点的数据/账号备份和旧配置；恢复安全 overlay、原挂载及明确旧镜像身份，绝不能用普通 latest。保留旧镜像/容器，不运行 prune。只有独立授权后才允许执行生产回滚。
