# 给网关的 config.toml 写入一个随机 api_key(网关要求 32~4096 位 ASCII、不含空白)。
# 由 setup-gateway.bat 调用: powershell -File new-key.ps1 -Path <config.toml>
# 已经有非空 api_key 时不改动, 直接回显原值。
param(
    [Parameter(Mandatory = $true)][string]$Path
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) {
    Write-Host "      [跳过] 找不到 $Path"
    exit 0
}

$text = Get-Content -LiteralPath $Path -Raw

# 已填过就保持原样(避免每次 init 都换 key, 机器人那边就得跟着改)
$existing = [regex]::Match($text, '(?m)^\s*api_key\s*=\s*"([^"]*)"')
if ($existing.Success -and $existing.Groups[1].Value.Trim().Length -ge 32) {
    Write-Host ("      已存在 api_key, 保持原值: " + $existing.Groups[1].Value)
    exit 0
}

# 用密码学随机数生成 48 位 [0-9A-Za-z]
$alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
$bytes = New-Object byte[] 48
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$key = -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })

if ($existing.Success) {
    # 有 api_key 行但为空/太短 -> 替换该行
    $text = [regex]::Replace($text, '(?m)^\s*api_key\s*=\s*"[^"]*"', ('api_key = "' + $key + '"'), 1)
} else {
    # 没有 api_key 行 -> 追加到文件末尾(TOML 的顶层键必须写在所有 [table] 之前, 这里保守追加并提示)
    $text = $text.TrimEnd() + "`r`n" + 'api_key = "' + $key + '"' + "`r`n"
}

Set-Content -LiteralPath $Path -Value $text -NoNewline -Encoding utf8
Write-Host ("      已写入 api_key: " + $key)
