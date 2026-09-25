# 本地验收记录 — 2026-09-25

执行目录：独立 `WechatOnCloud-no-chromium` 工作树；分支 `no-chromium`。原 main 未改。所有 API 测试使用临时账号文件、127.0.0.1 随机端口和内存 HTTP Docker mock，不连接生产 Docker。以下结果不是 NAS 实测。

| 检查 | 实际命令 | 结果 / 证据 |
| --- | --- | --- |
| 完整无需 Docker 门禁 | `bash scripts/check-no-chromium.sh` | 通过依赖安装、两端 tsc、TS/Python 测试、Vite/PWA、shell 语法、diff 检查；后续补充导出 helper 用例及最终改动又按下列定向命令复查 |
| TypeScript 行为 | `node --import ./panel/server/node_modules/tsx/dist/loader.mjs --test tests/*.test.ts` | 12 passed / 0 failed；含真实 Fastify HTTP + Docker mock 的权限、retired 读取/导出/显式删除、空 POST；无 Docker daemon |
| 同步/发布核验脚本 | `python3 -m unittest discover -s tests -p '*_test.py'` | 12 passed：同步 7 项（无更新、dry-run、新版/重复、冲突、检查失败、脏树、tag 移动），发布 pair 5 项（两个 digest、第二镜像缺失、身份、架构、latest 拒绝） |
| 后端类型 | `panel/server/node_modules/.bin/tsc --noEmit -p panel/server` | 通过；后端上游以 tsx 执行，没有单独 npm build，未伪称存在额外构建步骤 |
| 前端类型 | `panel/web/node_modules/.bin/tsc --noEmit -p panel/web` | 通过 |
| 前端构建 | `npm run build --prefix panel/web`；门禁后改用 `(cd panel/web && ./node_modules/.bin/vite build)` | 均通过；54 modules，PWA precache 9，生成 manifest.webmanifest、sw.js、workbox。直接 Vite 使用已跟踪图标，避免宿主 zlib 重生成 PNG 导致同步候选脏树；初次生成的图标已恢复到原始基线字节 |
| 工作流 | `/tmp/woc-actionlint/actionlint .github/workflows/release.yml .github/workflows/no-chromium-sync.yml` | actionlint 1.7.12 通过；YAML 另行解析通过。未运行远端 Actions |
| 启动脚本语法 | `bash -n docker/autostart docker/app-defs.sh docker/app-ctl.sh docker/woc-app-init.sh scripts/*.sh` | 通过 |
| Patch | `git diff --check` | 通过 |
| 安全 overlay | `cmp docker-compose.secure.yml /Volumes/Docker/WechatOnCloud/docker-compose.secure.yml` | 完全一致；只比较配置文件，不证明运行时已应用 |

开发中曾发现并修正：测试 TS 模块格式、retired 字段没有通过公开投影返回、同步冲突记录缺少 candidate SHA、类型收窄/流类型问题。最终上述测试均通过，没有隐藏失败或 continue-on-error。

未执行 / 不能宣称通过：

- Dockerfile 真正构建、最终镜像的可执行程序/包清单、基础镜像继承内容、两架构原生冒烟。
- 最终镜像微信客户端安装、WeChatAppEx `ldd`、真实微信登录、中文输入、剪贴板、文件传输及真实代理会话/PWA交互。
- Compose 合并结果的 Docker CLI 验证，NAS 实时容器 image/revision/mount/HostConfig/架构核验。SSH 认证失败，本机无 Docker 命令；未启动 OrbStack/Colima。
- GHCR 发布及新双镜像 registry digests；新 workflow 的 GitHub runner 实跑、仓库 Actions 权限/环境审批有效性。

没有推送、PR、tag/Release/镜像发布、默认分支切换、定时启用或 NAS 容器变更。脚本和文档准备的是后续独立授权执行路径。
