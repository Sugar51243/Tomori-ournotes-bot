@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ==========================================
echo   Tomori - BanG Dream! Our Notes 后端 API
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js, 请先安装 Node.js 20 或更高版本:
    echo        https://nodejs.org/
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo Node 版本: %%v
echo.

if not exist node_modules (
    echo [1/3] 首次运行, 安装依赖 ...
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败, 请检查网络后重试。
        pause
        exit /b 1
    )
) else (
    echo [1/3] 依赖已就绪
)

if not exist .env (
    copy /y .env.example .env >nul
    echo [2/3] 已根据 .env.example 生成 .env
) else (
    echo [2/3] 使用已有 .env 配置
)

echo [3/3] 构建并启动服务 ...
call npm run build
if errorlevel 1 (
    echo [错误] 构建失败。
    pause
    exit /b 1
)

echo.
echo 服务已启动, 按 Ctrl+C 停止。接口地址见下方日志。
echo.
call npm start
echo.
echo 服务已停止。
pause
