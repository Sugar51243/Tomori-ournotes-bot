@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Tomori Gateway Setup

rem ============================================================
rem  moenotes-api 自建网关 · 速搭脚本
rem
rem  用法: setup-gateway.bat [init^|run^|stop^|logs^|status]
rem    init    建目录 / 拉镜像 / 生成 config.toml 并自动填好 api_key (默认)
rem    run     启动网关容器(会先删掉同名旧容器, 配置改动即生效)
rem    stop    停止容器
rem    logs    跟踪容器日志
rem    status  探测 /healthz 与 /v1/status
rem
rem  网关能给 /searchPlayer 提供「查任意玩家」的能力(站点公开接口只能查已绑定公开的账号)。
rem  它持有游戏凭据, 只监听本机, 不要直接暴露公网。
rem ============================================================

rem 镜像没有 latest 标签, 升级时改这里的版本号(或填 Release 里的 digest)
set "IMAGE=ghcr.io/starmoe-org/moenotes-api:0.1.0-alpha.11"
set "NAME=moenotes-api"
set "HOST_PORT=8080"
set "DATA_DIR=%~dp0data"
set "ACCOUNTS_DIR=%~dp0accounts"
set "CONFIG=%DATA_DIR%\config.toml"
set "BASE_URL=http://127.0.0.1:%HOST_PORT%"

set "CMD=%~1"
if "%CMD%"=="" set "CMD=init"
if /i "%CMD%"=="init"   goto :init
if /i "%CMD%"=="run"    goto :run
if /i "%CMD%"=="stop"   goto :stop
if /i "%CMD%"=="logs"   goto :logs
if /i "%CMD%"=="status" goto :status
goto :usage

rem ------------------------------------------------------------
:init
echo ==========================================
echo   moenotes-api 自建网关 · 初始化
echo ==========================================
echo.
call :check_docker || exit /b 1

if not exist "%DATA_DIR%"     mkdir "%DATA_DIR%"
if not exist "%ACCOUNTS_DIR%" mkdir "%ACCOUNTS_DIR%"
echo [1/4] 目录就绪:
echo       配置与状态  %DATA_DIR%
echo       游戏账号    %ACCOUNTS_DIR%
echo.

echo [2/4] 拉取镜像 %IMAGE% ...
docker pull %IMAGE%
if errorlevel 1 (
    echo [错误] 镜像拉取失败, 请检查网络与 Docker 是否在运行。
    pause
    exit /b 1
)
echo.

echo [3/4] 生成配置模板 ...
if exist "%CONFIG%" (
    echo       已存在 %CONFIG%, 不覆盖。
) else (
    docker run --rm --network none --mount "type=bind,src=%DATA_DIR%,dst=/var/lib/moenotes" %IMAGE% init-config
    if exist "%CONFIG%" (
        echo       已生成 %CONFIG%
    ) else (
        echo       [提示] init-config 未生成文件; 首次 run 时容器也会在 data\ 下生成模板。
    )
)
echo.

echo [4/4] 写入随机 api_key ...
if not exist "%CONFIG%" (
    echo       [跳过] 还没有 config.toml, 请先执行一次 run 让它生成模板, 再回来跑 init。
) else (
    where powershell >nul 2>nul
    if errorlevel 1 (
        echo       [跳过] 未找到 powershell, 请手动把 config.toml 里的 api_key 填成 32 位以上随机字符串。
    ) else (
        powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0new-key.ps1" -Path "%CONFIG%"
    )
)
echo.

echo ==========================================
echo  初始化完成, 接下来:
echo ==========================================
echo.
echo  1) 编辑 %CONFIG%
echo     - [session] 段: 填区域、被许可的 origin、平台与客户端/数据版本
echo     - 多区域(tw/en/kr)各加一段 [regions.xx]; 日服按其 docs/jp-accounts.md 单独导入凭据
echo.
echo  2) 把游戏账号放进 %ACCOUNTS_DIR%
echo     国际服: 一个账号一个 JSON 文件, 内容形如
echo         {"user":"你的账号","password":"你的密码"}
echo     日服: 放进 accounts\jp\ ; 文件权限设成仅本人可读
echo.
echo  3) 启动:  setup-gateway.bat run
echo     自检:  setup-gateway.bat status
echo.
echo  4) 把网关接上机器人(bot/.env):
echo         MOENOTES_API_BASE=%BASE_URL%
echo         MOENOTES_API_KEY=^<上面写入 config.toml 的 api_key^>
echo     重启机器人后 /health 的 playerGateway 会变成 true。
echo.
pause
exit /b 0

rem ------------------------------------------------------------
:run
echo ==========================================
echo   启动 moenotes-api 网关
echo ==========================================
echo.
call :check_docker || exit /b 1

if not exist "%CONFIG%" (
    echo [错误] 还没有 %CONFIG%
    echo        先跑一次: setup-gateway.bat init   (或直接 run 一次生成模板后再 init)
    echo.
    pause
    exit /b 1
)
for /f "tokens=2 delims== " %%a in ('findstr /r /c:"^ *api_key *= *" "%CONFIG%"') do set "API_KEY=%%~a"
if "%API_KEY%"=="" (
    echo [错误] config.toml 里的 api_key 是空的 —— 网关会拒绝所有查询。
    echo        跑一次 setup-gateway.bat init 会自动填一个随机 key。
    echo.
    pause
    exit /b 1
)

docker rm -f %NAME% >nul 2>nul
docker run -d --name %NAME% --restart unless-stopped ^
  --cap-drop ALL --security-opt no-new-privileges ^
  -p 127.0.0.1:%HOST_PORT%:8080 ^
  --mount "type=bind,src=%DATA_DIR%,dst=/var/lib/moenotes" ^
  --mount "type=bind,src=%ACCOUNTS_DIR%,dst=/accounts,readonly" ^
  %IMAGE%
if errorlevel 1 (
    echo.
    echo [错误] 容器启动失败, 用 setup-gateway.bat logs 看原因。
    pause
    exit /b 1
)

echo.
echo 网关已启动(容器名 %NAME%, 只监听本机 %BASE_URL%)。
echo   看日志: setup-gateway.bat logs
echo   自检:   setup-gateway.bat status
echo.
echo 机器人侧配置(.env):
echo   MOENOTES_API_BASE=%BASE_URL%
echo   MOENOTES_API_KEY=%API_KEY%
echo.
pause
exit /b 0

rem ------------------------------------------------------------
:stop
call :check_docker || exit /b 1
docker stop %NAME%
if errorlevel 1 (
    echo [提示] 没有正在运行的 %NAME% 容器。
) else (
    echo 已停止 %NAME% (容器保留, 再 run 会重建)。
)
exit /b 0

rem ------------------------------------------------------------
:logs
call :check_docker || exit /b 1
echo 跟踪 %NAME% 日志, Ctrl+C 退出 ...
docker logs -f --tail 200 %NAME%
exit /b 0

rem ------------------------------------------------------------
:status
call :check_docker || exit /b 1
echo --- /healthz (进程存活) ---
curl -s -o nul -w "HTTP %%{http_code}\n" %BASE_URL%/healthz
for /f "tokens=2 delims== " %%a in ('findstr /r /c:"^ *api_key *= *" "%CONFIG%" 2^>nul') do set "API_KEY=%%~a"
if "%API_KEY%"=="" (
    echo.
    echo [提示] 没从 config.toml 读到 api_key, 跳过需要鉴权的 /v1/status。
    echo.
    pause
    exit /b 0
)
echo.
echo --- /v1/status (会话/版本状态, 需要 api_key) ---
curl -s -H "Authorization: Bearer %API_KEY%" %BASE_URL%/v1/status
echo.
echo.
echo 业务路由若返回 503, 说明配置还没填全(缺 [session] 或账号), 日志里会列出缺哪些键。
pause
exit /b 0

rem ------------------------------------------------------------
:check_docker
where docker >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 docker。请先安装 Docker Desktop:
    echo        https://www.docker.com/products/docker-desktop/
    echo.
    pause
    exit /b 1
)
docker info >nul 2>nul
if errorlevel 1 (
    echo [错误] Docker 已安装但没在运行, 请先启动 Docker Desktop。
    echo.
    pause
    exit /b 1
)
exit /b 0

rem ------------------------------------------------------------
:usage
echo ==========================================
echo   moenotes-api 自建网关 · 速搭脚本
echo ==========================================
echo.
echo   setup-gateway.bat init     建目录 / 拉镜像 / 生成配置并填好 api_key (默认)
echo   setup-gateway.bat run      启动网关容器
echo   setup-gateway.bat stop     停止容器
echo   setup-gateway.bat logs     跟踪容器日志
echo   setup-gateway.bat status   探测 /healthz 与 /v1/status
echo.
echo   镜像: %IMAGE%
echo   目录: %DATA_DIR%
echo         %ACCOUNTS_DIR%
echo.
pause
exit /b 0
