@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Tomori Database API

echo ==========================================
echo   Tomori 数据库 API
echo   (bot 与 web 共用的 MySQL/MongoDB 存取服务)
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
    echo [2/3] 已根据 .env.example 生成 .env —— 记得填 DB_API_TOKENS 与数据库连接信息
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
echo 服务已启动, 按 Ctrl+C 停止。
echo.
REM 窗口标题带端口(读 .env), 便于按标题精确结束进程 —— 见根 README「进程管理与防误杀」
set "PORTVAL="
for /f "usebackq tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="DB_API_PORT" set "PORTVAL=%%b"
set "PORTVAL=%PORTVAL: =%"
if defined PORTVAL (title Tomori Database API [%PORTVAL%]) else (title Tomori Database API)

call npm start
echo.
echo 服务已停止。
pause
